// ==UserScript==
// @name         B站弹幕发送 v4.4（修复油猴环境文件自动刷新）
// @namespace    http://tampermonkey.net/
// @version      4.4
// @description  修复油猴沙箱非法调用报错，每次循环从磁盘重新读取TXT最新内容，兼容所有浏览器
// @author       WorkBuddy
// @match        *://live.bilibili.com/*
// @match        *://df.qq.com/*
// @match        *://df.qq.com/cp/a20260611dfs/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.live.bilibili.com
// @connect      live.bilibili.com
// @connect      df.qq.com
// @connect      dfm.ams.game.qq.com
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        defaultInterval: 3,
        loopCooldownSec: 60,
        maxRetry: 3,
        maxDanmakuLen: 20,
        segmentDelay: 800,
        groupLines: 2,
        color: 16777215,
        fontsize: 25,
        mode: 1,
        bubble: 0,
    };

    const TEXT_REPLACE = [
        ['仓库总价值', '仓库价值'],
        ['击败干员数', '击败数'],
    ];

    function applyTextReplace(text) {
        if (!text) return text;
        let r = text;
        TEXT_REPLACE.forEach(([f, t]) => r = r.split(f).join(t));
        return r;
    }

    const state = {
        csrfToken: '',
        roomId: null,
        isRunning: false,
        timer: null,
        sendCount: 0,
        lastResponse: null,
        mode: 'txt',
        // 新版：文件句柄（支持自动读取磁盘最新内容）
        txtFileHandle: null,
        // 旧版：传统文件快照（兼容模式）
        txtFile: null,
        txtLastModified: 0,
        txtLines: [],
        txtGroups: [],
        txtIndex: 0,
        dfsPlayerId: '',
        dfsAutoRefresh: false,
        lastDfsData: null,
        currentIntervalMs: 3000,
        retryCount: 0,
        sendingSegment: false,
        loopTimer: null,
        loopCountdown: 0,
        groupsPerLoop: 3,
    };

    function getCookie(n) {
        const m = document.cookie.match(new RegExp('(^| )' + n + '=([^;]+)'));
        return m ? decodeURIComponent(m[2]) : '';
    }

    function splitDanmaku(text) {
        if (!text) return [];
        const r = [];
        for (let i = 0; i < text.length; i += CONFIG.maxDanmakuLen)
            r.push(text.slice(i, i + CONFIG.maxDanmakuLen));
        return r;
    }

    async function resolveRoomId() {
        try {
            if (window.__INITIAL_STATE__?.roomInitRes)
                return window.__INITIAL_STATE__.roomInitRes.data.room_id;
        } catch {}
        const s = window.location.pathname.replace('/', '');
        if (!s) return null;
        try {
            const r = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${s}`);
            const d = await r.json();
            if (d.code === 0) return d.data.room_id;
        } catch {}
        return parseInt(s) || null;
    }

    /**
     * 重新读取TXT文件最新内容
     * 优先级：1.文件句柄模式（自动刷新） 2.传统文件模式（兼容）
     */
    function reloadTxtFile() {
        return new Promise(async (resolve) => {
            let fileToRead = null;
            let isAutoMode = false;

            // 优先使用新版文件句柄，每次从磁盘获取最新文件
            if (state.txtFileHandle) {
                try {
                    fileToRead = await state.txtFileHandle.getFile();
                    isAutoMode = true;
                } catch (e) {
                    log('❌ 获取文件最新内容失败，请重新选择文件');
                    resolve(false);
                    return;
                }
            }
            // 降级：传统文件快照
            else if (state.txtFile) {
                fileToRead = state.txtFile;
            }
            // 未选择任何文件
            else {
                log('⚠️ 未选择TXT文件');
                resolve(false);
                return;
            }

            const reader = new FileReader();
            reader.onload = () => {
                const content = reader.result;
                const lines = content
                    .split(/\r?\n/)
                    .map(l => applyTextReplace(l.trim()))
                    .filter(Boolean);

                if (lines.length === 0) {
                    log('⚠️ TXT文件为空');
                    resolve(false);
                    return;
                }

                // 检测文件是否被修改过
                const wasModified = state.txtLastModified !== fileToRead.lastModified;
                if (wasModified) {
                    log(`📝 检测到文件更新（${new Date(fileToRead.lastModified).toLocaleTimeString()}）`);
                    state.txtLastModified = fileToRead.lastModified;
                }

                state.txtLines = lines;
                state.txtGroups = [];
                for (let i = 0; i < lines.length; i += CONFIG.groupLines) {
                    state.txtGroups.push(lines.slice(i, i + CONFIG.groupLines).join(' '));
                }
                state.txtIndex = 0;
                log(`✅ TXT已刷新：${state.txtGroups.length}组${isAutoMode ? '（自动刷新模式）' : '（兼容模式）'}`);
                resolve(true);
            };
            reader.onerror = () => {
                log('❌ 读取TXT文件失败');
                resolve(false);
            };
            reader.readAsText(fileToRead, 'UTF-8');
        });
    }

    function sendDanmaku(text, cb) {
        if (!state.roomId || !state.csrfToken) { cb(false, '参数缺失'); return; }
        const p = new URLSearchParams({
            msg: text, roomid: state.roomId, color: CONFIG.color,
            fontsize: CONFIG.fontsize, mode: CONFIG.mode, bubble: CONFIG.bubble,
            csrf: state.csrfToken, csrf_token: state.csrfToken,
            rnd: Math.floor(Date.now() / 1000),
        });
        fetch('https://api.live.bilibili.com/msg/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': location.origin },
            body: p.toString(), credentials: 'include',
        }).then(r => r.json()).then(res => {
            state.lastResponse = res;
            cb(res.code === 0, res.message || `code=${res.code}`);
        }).catch(() => cb(false, '网络错误'));
    }

    function sendDanmakuSegments(text, onComplete) {
        const segs = splitDanmaku(text);
        if (segs.length === 0) { onComplete(false); return; }
        state.sendingSegment = true;
        let i = 0;
        const sendNext = () => {
            if (!state.isRunning || i >= segs.length) {
                state.sendingSegment = false;
                onComplete(true); return;
            }
            sendDanmaku(segs[i++], (ok) => {
                if (ok) {
                    state.sendCount++; updateProgress();
                    setTimeout(sendNext, CONFIG.segmentDelay);
                } else {
                    state.retryCount++;
                    if (state.retryCount >= CONFIG.maxRetry) {
                        state.sendingSegment = false;
                        stopSpamming(); onComplete(false); return;
                    }
                    setTimeout(() => sendDanmaku(segs[i - 1], () => {
                        setTimeout(sendNext, CONFIG.segmentDelay);
                    }), 2000);
                }
            });
        };
        sendNext();
    }

    function startLoopCooldown() {
        state.isRunning = false;
        state.loopCountdown = CONFIG.loopCooldownSec;
        log(`✅ 完成一个循环，等待 ${state.loopCountdown}s 后重新读取文件...`);
        updateCooldownUI(state.loopCountdown);
        state.loopTimer = setInterval(async () => {
            state.loopCountdown--;
            updateCooldownUI(state.loopCountdown);
            if (state.loopCountdown <= 0) {
                clearInterval(state.loopTimer);
                state.loopTimer = null;
                updateCooldownUI(0);
                log('🔄 正在读取TXT最新内容...');
                const ok = await reloadTxtFile();
                if (!ok) {
                    log('⚠️ 读取失败，停止发送');
                    stopSpamming();
                    return;
                }
                log('🔄 循环重新开始');
                state.isRunning = true;
                sendNext();
            }
        }, 1000);
    }

    function updateCooldownUI(s) {
        const el = document.getElementById('cooldown-text');
        if (!el) return;
        el.textContent = s > 0 ? `⏳ 冷却中… ${s}s（即将重读文件）` : '';
        el.style.color = s > 0 ? '#FFA502' : '';
    }

    // ==================== DFS 巅峰赛模块 ====================

    const DFS_REQUEST_KEY = 'DFS_QUERY_REQUEST';
    const DFS_RESPONSE_KEY = 'DFS_QUERY_RESPONSE';

    function buildDfsUrl(name) {
        return 'https://dfm.ams.game.qq.com/ide/?'
            + new URLSearchParams({
                iChartId: '570030', iSubChartId: '570030', sIdeToken: 'H0A9F4',
                sPlatId: '0', sArea: '36', type: '1', page: '1',
                search: name, competitionId: '1', pageNo: '10',
            });
    }

    if (location.hostname.includes('df.qq.com')) {
        let lastId = '';
        setInterval(async () => {
            const req = GM_getValue(DFS_REQUEST_KEY, '');
            if (!req || req.id === lastId) return;
            lastId = req.id;
            try {
                const r = await fetch(buildDfsUrl(req.playerName), { credentials: 'include' });
                const d = await r.json();
                GM_setValue(DFS_RESPONSE_KEY, {
                    id: req.id, ok: d.iRet === 0,
                    rank: d.jData?.sqlData?.[0]?.rankwid || '-',
                    asset: d.jData?.sqlData?.[0]?.warehouseValue || '-',
                });
            } catch {
                GM_setValue(DFS_RESPONSE_KEY, { id: req.id, ok: false });
            }
        }, 500);
        return;
    }

    function queryDfsPlayer(name, cb) {
        const id = Date.now().toString(36);
        GM_setValue(DFS_RESPONSE_KEY, '');
        GM_setValue(DFS_REQUEST_KEY, { id, playerName: name });
        const start = Date.now();
        const poll = () => {
            const res = GM_getValue(DFS_RESPONSE_KEY, '');
            if (res?.id === id) { cb(res.ok, res.ok ? res : res.msg || '查询失败'); return; }
            if (Date.now() - start > 15000) { cb(false, '查询超时'); return; }
            setTimeout(poll, 300);
        };
        poll();
    }

    // ==================== UI 面板 ====================

    let panel;

    function log(msg) {
        const box = document.getElementById('spam-log');
        if (!box) return;
        const t = new Date().toLocaleTimeString();
        box.insertAdjacentHTML('afterbegin', `<div>[${t}] ${msg}</div>`);
        while (box.children.length > 50) box.lastChild.remove();
    }

    function updateProgress() {
        const el = document.getElementById('progress-text');
        if (el) el.textContent = `已发送 ${state.sendCount} 条弹幕`;
    }

    function updateStatus(text, color) {
        const el = document.getElementById('conn-status');
        if (el) { el.textContent = text; el.style.color = color || '#666'; }
    }

    function stopSpamming() {
        state.isRunning = false;
        state.sendingSegment = false;
        if (state.timer) clearTimeout(state.timer);
        if (state.loopTimer) clearInterval(state.loopTimer);
        state.loopTimer = null;
        updateCooldownUI(0);
        log('已停止');
        const a = document.getElementById('start-btn');
        const b = document.getElementById('stop-btn');
        if (a) a.style.display = 'inline-block';
        if (b) b.style.display = 'none';
    }

    function sendNext() {
        if (!state.isRunning || state.sendingSegment) return;
        if (state.loopTimer) return;

        if (state.mode === 'txt') {
            if (state.txtGroups.length === 0) {
                log('TXT 内容为空，请重新选择文件');
                stopSpamming(); return;
            }
            const g = state.txtIndex + 1;
            const text = state.txtGroups[state.txtIndex];
            state.txtIndex = (state.txtIndex + 1) % state.txtGroups.length;
            log(`发送第 ${g}/${state.txtGroups.length} 组`);
            sendDanmakuSegments(text, () => {
                if (!state.isRunning) return;
                if (state.txtIndex === 0 || state.txtIndex % state.groupsPerLoop === 0) {
                    startLoopCooldown();
                } else {
                    state.timer = setTimeout(sendNext, state.currentIntervalMs);
                }
            });
        } else {
            const tpl = document.getElementById('dfs-danmaku-tpl')?.value || '排名:{rank} 资产:{asset}';
            const send = (data) => {
                let msg = tpl.replace(/{rank}/g, data.rank).replace(/{asset}/g, data.asset);
                msg = applyTextReplace(msg);
                sendDanmakuSegments(msg, () => {
                    if (state.isRunning) state.timer = setTimeout(sendNext, state.currentIntervalMs);
                });
            };
            if (state.dfsAutoRefresh) {
                queryDfsPlayer(state.dfsPlayerId, (ok, data) => {
                    if (ok) {
                        document.getElementById('dfs-result').innerHTML =
                            `<strong>排名：</strong>${data.rank} <strong>资产：</strong>${data.asset}`;
                        send(data);
                    } else {
                        log('查询失败：' + data);
                        state.timer = setTimeout(sendNext, state.currentIntervalMs);
                    }
                });
            } else if (state.lastDfsData) {
                send(state.lastDfsData);
            }
        }
    }

    function createPanel() {
        if (panel) { panel.style.display = 'block'; return; }

        panel = document.createElement('div');
        panel.id = 'txt-spam-panel';
        panel.style.cssText = `
            position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:540px;background:#fff;border-radius:12px;z-index:99999;
            padding:20px;font-family:Arial;box-shadow:0 10px 30px rgba(0,0,0,.3);
            max-height:90vh;overflow-y:auto;
        `;

        // 检测油猴环境下是否支持文件自动刷新API
        const supportAutoRefresh = typeof unsafeWindow !== 'undefined' && 'showOpenFilePicker' in unsafeWindow;

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:15px;">
                <h3 style="margin:0;color:#FB7299;">📝 弹幕发送 v4.4（油猴修复版）</h3>
                <button id="panel-close-btn" style="background:none;border:none;font-size:22px;cursor:pointer;">&times;</button>
            </div>

            <div style="margin-bottom:10px;padding:8px;background:#f0f9ff;border-radius:4px;font-size:12px;color:#666;">
                状态: <span id="conn-status">检查中...</span>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:5px;font-weight:bold;">模式选择</label>
                <select id="mode-select" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;">
                    <option value="txt">TXT 文件（2行一组）</option>
                    <option value="dfs">巅峰赛选手查询</option>
                </select>
            </div>

            <div id="txt-area">
                <div style="margin-bottom:10px;">
                    <label style="display:block;margin-bottom:5px;font-weight:bold;">1. 选择文件 (.txt)</label>
                    ${supportAutoRefresh ? `
                    <button id="btn-pick-file" style="width:100%;padding:8px;background:#2ED573;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;margin-bottom:6px;">
                        📂 选择TXT文件（推荐·自动刷新最新内容）
                    </button>
                    <div style="font-size:11px;color:#2e7d32;margin-bottom:6px;">
                        ✅ 本地文件修改后，每次循环自动读取最新内容，无需重复选择
                    </div>
                    <div style="font-size:11px;color:#999;border-top:1px dashed #eee;padding-top:6px;">
                        下方为兼容模式（不推荐，修改文件需重新选择）：
                    </div>
                    ` : ''}
                    <input type="file" id="txt-file" accept=".txt" style="width:100%;">
                    <div id="txt-mode-tip" style="font-size:11px;color:${supportAutoRefresh ? '#e67e22' : '#2e7d32'};margin-top:4px;">
                        ${supportAutoRefresh ? '⚠️ 当前为兼容模式，修改文件后需手动重新选择' : '✅ 当前浏览器模式，每次循环重新读取'}
                    </div>
                    <div id="txt-info" style="font-size:12px;color:#888;margin-top:5px;">未选择文件</div>
                </div>

                <div style="margin-bottom:10px;">
                    <label style="display:block;margin-bottom:5px;font-weight:bold;">2. 每组发送间隔（秒）</label>
                    <input type="number" id="txt-interval" value="3" min="1" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;">
                </div>

                <div style="margin-bottom:10px;">
                    <label style="display:block;margin-bottom:5px;font-weight:bold;">3. 循环时间（秒）</label>
                    <input type="number" id="loop-cooldown" value="60" min="1" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;">
                    <div style="font-size:11px;color:#888;margin-top:3px;">
                        💡 每发送3组后，等待该时间并重新从磁盘读取TXT最新内容
                    </div>
                </div>

                <div style="margin-bottom:10px;padding:6px 8px;background:#e8f5e9;border-radius:4px;font-size:11px;color:#2e7d32;">
                    ✅ 自动替换：仓库总价值→仓库价值，击败干员数→击败数<br>
                    ✅ 每次循环重新读取TXT文件最新内容<br>
                    ✅ 兼容所有浏览器，Chrome/Edge推荐使用自动刷新模式
                </div>
            </div>

            <div id="dfs-area" style="display:none;">
                <div style="margin-bottom:10px;padding:8px;background:#fff3cd;border-radius:4px;font-size:11px;color:#856404;">
                    <strong>重要：</strong>请先打开并登录
                    <a href="https://df.qq.com/cp/a20260611dfs/" target="_blank" style="color:#533f03;">df.qq.com</a>
                </div>

                <div style="margin-bottom:10px;">
                    <label style="display:block;margin-bottom:5px;font-weight:bold;">1. 选手名称</label>
                    <input type="text" id="dfs-name" placeholder="输入选手名称" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;">
                    <button id="btn-dfs-query" style="margin-top:4px;padding:4px 8px;font-size:12px;">立即查询</button>
                </div>

                <label style="display:flex;align-items:center;gap:4px;font-size:12px;margin-bottom:10px;">
                    <input type="checkbox" id="dfs-refresh"> 自动刷新
                </label>

                <div id="dfs-result" style="font-size:12px;min-height:24px;margin-bottom:10px;"></div>

                <div style="margin-bottom:10px;">
                    <label style="display:block;margin-bottom:5px;font-weight:bold;">2. 发送间隔（秒）</label>
                    <input type="number" id="dfs-interval" value="10" min="1" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;">
                </div>

                <div style="margin-bottom:10px;">
                    <label style="display:block;margin-bottom:5px;font-weight:bold;">3. 弹幕模板</label>
                    <input type="text" id="dfs-danmaku-tpl" value="排名:{rank} 资产:{asset}" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;">
                </div>
            </div>

            <div style="margin-bottom:10px;">
                <label style="display:block;margin-bottom:5px;font-weight:bold;">运行日志</label>
                <div id="spam-log" style="height:100px;overflow-y:auto;background:#f5f5f5;padding:6px;font-size:12px;border-radius:4px;font-family:monospace;line-height:1.6;">等待开始...</div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
                <span id="progress-text" style="font-size:12px;color:#999;">已发送 0 条弹幕</span>
                <span id="cooldown-text" style="font-size:12px;font-weight:bold;"></span>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;">
                <button id="stop-btn" style="padding:8px 15px;background:#FF4757;color:white;border:none;border-radius:4px;cursor:pointer;display:none;">停止</button>
                <button id="start-btn" style="padding:8px 15px;background:#2ED573;color:white;border:none;border-radius:4px;cursor:pointer;">开始发送</button>
            </div>
        `;

        document.body.appendChild(panel);

        panel.querySelector('#panel-close-btn').onclick = () => panel.style.display = 'none';

        panel.querySelector('#mode-select').onchange = e => {
            state.mode = e.target.value;
            panel.querySelector('#txt-area').style.display = state.mode === 'txt' ? 'block' : 'none';
            panel.querySelector('#dfs-area').style.display = state.mode === 'dfs' ? 'block' : 'none';
            log(`切换模式：${state.mode === 'txt' ? 'TXT文件' : '巅峰赛查询'}`);
        };

        // ========== 核心修复：油猴环境下正常调用文件选择API ==========
        if (supportAutoRefresh) {
            panel.querySelector('#btn-pick-file').onclick = async () => {
                try {
                    // 从原生unsafeWindow获取API，并显式绑定this，解决Illegal invocation
                    const nativePickFile = unsafeWindow.showOpenFilePicker;
                    const [handle] = await nativePickFile.call(unsafeWindow, {
                        types: [{
                            description: '文本文件',
                            accept: { 'text/plain': ['.txt'] }
                        }],
                        multiple: false
                    });
                    // 保存文件句柄，清空兼容模式文件
                    state.txtFileHandle = handle;
                    state.txtFile = null;
                    // 首次预览读取
                    const file = await handle.getFile();
                    state.txtLastModified = file.lastModified;
                    const reader = new FileReader();
                    reader.onload = () => {
                        const lines = reader.result.split(/\r?\n/).map(l => applyTextReplace(l.trim())).filter(Boolean);
                        document.getElementById('txt-info').textContent =
                            `已选择：${file.name}（${lines.length}行·自动刷新模式）`;
                        document.getElementById('txt-mode-tip').textContent = '✅ 自动刷新模式：本地文件修改后自动读取最新内容';
                        document.getElementById('txt-mode-tip').style.color = '#2e7d32';
                        log(`已选择文件：${file.name}（自动刷新模式已开启）`);
                    };
                    reader.readAsText(file, 'UTF-8');
                } catch (e) {
                    // 用户主动取消选择不报错
                    if (e.name !== 'AbortError') {
                        log('选择文件失败：' + e.message);
                        console.error('文件选择详细报错：', e);
                    }
                }
            };
        }

        // 兼容模式：传统文件选择
        panel.querySelector('#txt-file').onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            state.txtFile = file;
            state.txtFileHandle = null;
            state.txtLastModified = file.lastModified;
            const reader = new FileReader();
            reader.onload = () => {
                const lines = reader.result.split(/\r?\n/).map(l => applyTextReplace(l.trim())).filter(Boolean);
                document.getElementById('txt-info').textContent =
                    `已选择：${file.name}（${lines.length}行·兼容模式）`;
                if (supportAutoRefresh) {
                    document.getElementById('txt-mode-tip').textContent = '⚠️ 兼容模式：修改本地文件后需重新选择才能更新';
                    document.getElementById('txt-mode-tip').style.color = '#e67e22';
                }
                log(`已选择文件：${file.name}（兼容模式）`);
            };
            reader.readAsText(file, 'UTF-8');
        };

        panel.querySelector('#btn-dfs-query').onclick = () => {
            const name = panel.querySelector('#dfs-name').value.trim();
            if (!name) { log('请输入选手名称'); return; }
            log('查询中...');
            queryDfsPlayer(name, (ok, data) => {
                if (ok) {
                    document.getElementById('dfs-result').innerHTML =
                        `<strong>排名：</strong>${data.rank} <strong>资产：</strong>${data.asset}`;
                    state.lastDfsData = data;
                    log(`查询成功：排名${data.rank}，资产${data.asset}`);
                } else {
                    document.getElementById('dfs-result').textContent = data;
                    log(`查询失败：${data}`);
                }
            });
        };

        panel.querySelector('#dfs-refresh').onchange = e => state.dfsAutoRefresh = e.target.checked;

        panel.querySelector('#start-btn').onclick = async () => {
            if (state.mode === 'txt') {
                state.currentIntervalMs = parseInt(panel.querySelector('#txt-interval').value || '3') * 1000;
                CONFIG.loopCooldownSec = parseInt(panel.querySelector('#loop-cooldown').value || '60');
                if (!state.txtFileHandle && !state.txtFile) { alert('请先选择TXT文件'); return; }
                log('📖 首次读取TXT文件...');
                const ok = await reloadTxtFile();
                if (!ok) { alert('读取TXT文件失败或文件为空'); return; }
                document.getElementById('txt-info').textContent =
                    `已加载：${state.txtLines.length}行 → ${state.txtGroups.length}组`;
                log(`TXT加载完成：${state.txtGroups.length}组`);
            } else {
                state.currentIntervalMs = parseInt(panel.querySelector('#dfs-interval').value || '10') * 1000;
                state.dfsPlayerId = panel.querySelector('#dfs-name').value.trim();
                if (!state.dfsPlayerId) { alert('请输入选手名称'); return; }
                if (!state.lastDfsData) {
                    log('正在初始查询...');
                    queryDfsPlayer(state.dfsPlayerId, (ok, data) => {
                        if (ok) {
                            state.lastDfsData = data;
                            document.getElementById('dfs-result').innerHTML =
                                `<strong>排名：</strong>${data.rank} <strong>资产：</strong>${data.asset}`;
                            startSending();
                        } else {
                            log('初始查询失败：' + data);
                            alert('初始查询失败：' + data);
                        }
                    });
                    return;
                }
            }
            startSending();
        };

        panel.querySelector('#stop-btn').onclick = stopSpamming;

        function startSending() {
            panel.querySelector('#start-btn').style.display = 'none';
            panel.querySelector('#stop-btn').style.display = 'inline-block';
            state.isRunning = true;
            state.sendCount = 0;
            state.retryCount = 0;
            state.txtIndex = 0;
            log('▶️ 开始发送任务...');
            sendNext();
        }
    }

    function init() {
        state.csrfToken = getCookie('bili_jct');

        const btn = document.createElement('div');
        btn.textContent = '📝 发弹幕';
        btn.style.cssText = 'position:fixed;bottom:100px;right:20px;z-index:9999;background:#FB7299;color:#fff;padding:10px 14px;border-radius:8px;cursor:pointer;font-weight:bold;box-shadow:0 4px 6px rgba(0,0,0,.2);';
        btn.onclick = () => { createPanel(); panel.style.display = 'block'; };
        document.body.appendChild(btn);

        resolveRoomId().then(id => {
            state.roomId = id;
            if (!state.csrfToken) updateStatus('未登录', 'red');
            else if (!state.roomId) updateStatus('未获取房间号', 'red');
            else updateStatus(`已就绪 | 房间: ${state.roomId}`, 'green');
        });

        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand("📝 打开发送面板", () => { createPanel(); panel.style.display = 'block'; });
        }
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else init();

})();
