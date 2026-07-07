# -*- coding: utf-8 -*-
"""
数据抓取模块
用 Playwright 渲染官网页面，调用页面自带Search搜索框精准查询主播，无需爬全榜单
【架构说明】
所有 async 函数在同一个事件循环中运行（由 obs_rank.py 的 asyncio.run 统一管理）。
绝不在此文件内部使用 asyncio.run()，否则会导致 Playwright 对象跨事件循环报错。
"""
import asyncio
import json
import time
import os
import sys
import re
from playwright.async_api import async_playwright

PAGE_URL = "https://df.qq.com/cp/a20260611dfs/index.html"

# 缓存文件路径
if getattr(sys, "frozen", False):
    _CACHE_DIR = os.path.dirname(sys.executable)
else:
    _CACHE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(_CACHE_DIR, "delta_rank_cache.json")
CACHE_EXPIRE = 300  # 5分钟缓存

# 全局浏览器实例（复用，避免频繁启停）
_BROWSER = None
_CONTEXT = None
_PAGE = None
_PLAYWRIGHT = None  # 保存 playwright 实例引用，退出时需要 stop()


# ===================== 工具函数 =====================
def _normalize_name(name: str) -> str:
    """标准化主播名称：去空格、去中英文括号及内容、转小写，用于精确匹配"""
    if not name:
        return ""
    name = str(name).lower()
    name = re.sub(r'\s+', '', name)  # 去所有空白字符
    name = re.sub(r'（[^）]*）', '', name)  # 去中文括号及内容
    name = re.sub(r'\([^)]*\)', '', name)  # 去英文括号及内容
    return name


# ===================== 浏览器管理 =====================
async def _try_launch_browser(p):
    """自动探测可用浏览器：Chrome → Edge → Playwright内置Chromium"""
    last_error = None
    for ch in ['chrome', 'msedge']:
        try:
            browser = await p.chromium.launch(channel=ch, headless=True)
            print("[浏览器] 使用 %s" % ch)
            return browser
        except Exception as e:
            last_error = e
            print("[浏览器] %s 不可用: %s" % (ch, str(e)[:60]))
    try:
        browser = await p.chromium.launch(headless=True)
        print("[浏览器] 使用 Playwright 内置 Chromium")
        return browser
    except Exception as e:
        print("[浏览器] 所有浏览器均不可用！")
        raise last_error or e


async def init_browser():
    """初始化浏览器（全局只调用一次，必须在事件循环内 await 调用）"""
    global _BROWSER, _CONTEXT, _PAGE, _PLAYWRIGHT
    if _BROWSER:
        return
    _PLAYWRIGHT = await async_playwright().start()
    _BROWSER = await _try_launch_browser(_PLAYWRIGHT)
    _CONTEXT = await _BROWSER.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    )
    _PAGE = await _CONTEXT.new_page()
    # 初始加载页面
    await _PAGE.goto(PAGE_URL, wait_until="domcontentloaded", timeout=60000)
    # 等待关键 JS 对象加载完毕
    await _PAGE.wait_for_function("() => typeof main !== 'undefined'", timeout=30000)
    print("[浏览器] 页面初始化完成")


async def close_browser():
    """关闭浏览器（必须在事件循环内 await 调用）"""
    global _BROWSER, _CONTEXT, _PAGE, _PLAYWRIGHT
    if _BROWSER:
        try:
            await _BROWSER.close()
            print("[浏览器] 已关闭")
        except Exception as e:
            print("[浏览器] 关闭异常: %s" % e)
    if _PLAYWRIGHT:
        try:
            await _PLAYWRIGHT.stop()
        except Exception:
            pass
    _BROWSER = None
    _CONTEXT = None
    _PAGE = None
    _PLAYWRIGHT = None


# ===================== 缓存管理 =====================
def load_cache():
    """读取本地缓存（全量数据）"""
    if not os.path.exists(CACHE_FILE):
        return None
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            cache_data = json.load(f)
        if time.time() - cache_data.get("timestamp", 0) < CACHE_EXPIRE:
            return cache_data.get("data")
    except Exception:
        pass
    return None


def load_cache_item(anchor_name):
    """从缓存中读取特定主播（精确匹配，彻底避免串数据）"""
    if not anchor_name:
        return None
    cache = load_cache()
    if not cache or not cache.get("rankList"):
        return None
    target_norm = _normalize_name(anchor_name)
    for item in cache["rankList"]:
        item_name = str(item.get("userName", ""))
        if _normalize_name(item_name) == target_norm:
            print("[缓存] 精确命中主播: %s" % item_name)
            return item
    return None


def save_cache(data):
    """写入缓存"""
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": time.time(),
            "data": {"rankList": data}
        }, f, ensure_ascii=False, indent=2)


# ===================== 核心抓取逻辑 =====================
async def _fetch_rank_data(rank_type=1, competition_id=0, plat_name="", search="", page=1):
    """利用已打开的页面执行搜索（必须在事件循环内 await 调用）"""
    global _PAGE
    if not _PAGE:
        raise RuntimeError("Browser not initialized. Call init_browser() first.")
    # JS注入：填充搜索框、触发前端搜索
    js_set = """
    (params) => {
        var competitionId = params.competitionId;
        var platName = params.platName;
        var search = params.search;
        var rankType = params.rankType;
        var page = params.page;
        var selects = document.querySelectorAll('.sssj_xl select');
        if (selects.length >= 2) {
            selects[0].value = String(competitionId);
            selects[1].value = platName;
        }
        var inp = document.getElementById('search');
        if (inp) {
            inp.value = search;
            inp.dispatchEvent(new Event('input'));
            inp.dispatchEvent(new Event('change'));
        }
        if (typeof main !== 'undefined') {
            main.rankType = rankType;
            main.rankPage = page;
            main.rankListAPI(rankType, page);
        }
    }
    """
    await _PAGE.evaluate(js_set, {
        "competitionId": competition_id,
        "platName": plat_name,
        "search": search,
        "rankType": rank_type,
        "page": page
    })
    # 关键：等待前端数据更新完毕，而非固定等待
    await _PAGE.wait_for_function(
        "() => Array.isArray(main.rankListData) && main.rankListData.length > 0",
        timeout=15000
    )
    # 读取筛选后数据
    js_read = """
    () => ({
        rankList: main.rankListData || [],
        totalPage: main.rankTotalPage || 1,
        currentPage: main.rankPage || 1
    });
    """
    return await _PAGE.evaluate(js_read)


async def search_anchor_by_name(anchor_name, rank_type=1, competition_id=0):
    """
    核心：直接搜索单个主播（async，必须 await 调用）
    统一在 obs_rank.py 的事件循环中运行，不复用旧的 asyncio.run 模式。
    """
    try:
        res = await _fetch_rank_data(
            rank_type=rank_type,
            competition_id=competition_id,
            search=anchor_name,
            page=1
        )
        if res and res.get("rankList"):
            first_item = res["rankList"][0]
            result_name = str(first_item.get("userName", ""))
            # 验证搜索结果确实匹配（官网搜不到时会返回全量榜单）
            target_norm = _normalize_name(anchor_name)
            if _normalize_name(result_name) == target_norm:
                save_cache(res["rankList"])
                return first_item
            print("[搜索] 未匹配: 搜索'%s'，返回'%s'" % (anchor_name, result_name))
    except Exception as e:
        err_msg = str(e)
        if "not found" in err_msg or "Executable doesn't exist" in err_msg:
            print("[抓取错误] 未找到可用浏览器，请安装 Chrome 或 Edge 浏览器")
        else:
            print("[抓取错误] %s" % err_msg)
    return None
