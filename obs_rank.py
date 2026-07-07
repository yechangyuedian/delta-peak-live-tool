# -*- coding: utf-8 -*-
"""
OBS 直播排名显示脚本
依托官网自带搜索框精准查询，定时自动更新
【使用方法】
1. 双击 exe 运行
2. 首次运行会提示输入主播参赛名称，自动保存到 config.ini
3. 以后每次运行自动读取 config.ini，无需重复输入
4. 搜不到主播时控制台自动提示重新输入ID，无需重启程序
5. OBS 读取同目录 obs_rank_display.txt 作为文本源
"""
import asyncio
import os
import sys
import time
import configparser

# ===================== 常量 =====================
OUTPUT_TXT_NAME = "obs_rank_display.txt"
CONFIG_NAME     = "config.ini"
DEFAULT_REFRESH = 10  # 默认刷新间隔(分钟)


# ===================== 路径工具 =====================
def get_base_dir():
    """获取 exe 所在目录（打包后）或脚本所在目录（开发时）"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _config_path():
    return os.path.join(get_base_dir(), CONFIG_NAME)


def _log_path():
    return os.path.join(get_base_dir(), "obs_rank.log")


def _output_txt_path():
    return os.path.join(get_base_dir(), OUTPUT_TXT_NAME)


def _cache_path():
    return os.path.join(get_base_dir(), "delta_rank_cache.json")


# ===================== 日志 =====================
def log(msg):
    now = time.strftime("%m-%d %H:%M:%S")
    line = "[%s] %s" % (now, msg)
    print(line)
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ===================== 配置文件读写 =====================
def load_config():
    """读取 config.ini，返回 (主播名, 刷新间隔) 或 None"""
    cp = configparser.ConfigParser()
    try:
        cp.read(_config_path(), encoding="utf-8")
        if cp.has_section("SETTING"):
            name = cp.get("SETTING", "AnchorName", fallback="").strip()
            refresh = cp.getint("SETTING", "RefreshMin", fallback=DEFAULT_REFRESH)
            if name:
                return name, refresh
    except Exception as e:
        log("读取配置文件失败: %s" % e)
    return None


def save_config(anchor_name, refresh_min):
    """保存配置到 config.ini"""
    cp = configparser.ConfigParser()
    cp["SETTING"] = {
        "AnchorName": anchor_name,
        "RefreshMin": str(refresh_min),
    }
    try:
        with open(_config_path(), "w", encoding="utf-8") as f:
            cp.write(f)
        log("配置已保存：" + _config_path())
    except Exception as e:
        log("保存配置文件失败: %s" % e)


# ===================== 交互式配置 =====================
def _safe_input(prompt):
    """input() 的安全封装，EOFError 时返回空字符串"""
    try:
        return input(prompt)
    except EOFError:
        return ""


def prompt_config(existing_name=None, existing_refresh=DEFAULT_REFRESH):
    """首次运行或修改时的配置向导"""
    print()
    print("=" * 50)
    print("  三角洲行动 · 主播巅峰赛排名挂件 - 设置")
    print("=" * 50)
    print()
    if existing_name:
        print("当前追踪主播：【%s】  刷新间隔：%d分钟" % (existing_name, existing_refresh))
        print()
        try:
            choice = input("是否修改？(输入 y 修改，直接回车保持不变): ").strip().lower()
        except EOFError:
            choice = ""
        if choice != "y":
            return existing_name, existing_refresh
    print()
    print("请输入你要追踪的主播参赛名称（就是巅峰赛榜单上显示的名字）")
    name = _safe_input("主播名称: ")
    while not name:
        print("名称不能为空，请重新输入！")
        name = _safe_input("主播名称: ")
    print()
    print("请输入自动刷新间隔（分钟，建议 5~30，直接回车默认 %d 分钟）" % DEFAULT_REFRESH)
    refresh_str = _safe_input("刷新间隔: ").strip()
    try:
        refresh = int(refresh_str) if refresh_str else DEFAULT_REFRESH
        refresh = max(refresh, 5)  # 强制最低5分钟，防止被封IP
    except ValueError:
        refresh = DEFAULT_REFRESH
    save_config(name, refresh)
    print()
    print("设置完成！")
    print("  追踪主播：【%s】" % name)
    print("  刷新间隔：%d 分钟" % refresh)
    print()
    return name, refresh


# ===================== 运行时重配置 =====================
def clear_cache_file():
    """删除缓存文件（换主播时必须清理，防止读到旧数据）"""
    try:
        cache_path = _cache_path()
        if os.path.exists(cache_path):
            os.remove(cache_path)
            log("旧缓存已清理")
    except Exception as e:
        log("清理缓存失败: %s" % e)


def reconfigure_anchor(current_refresh, current_name):
    """
    当主播未找到时，要求用户重新输入ID。
    返回新的主播名称；如果无法获取输入（如管道模式），返回旧名继续等。
    """
    print()
    print("!" * 50)
    print("  未找到当前主播，请重新输入参赛名称")
    print("!" * 50)
    retry = 0
    new_name = _safe_input("请输入新的主播名称: ").strip()
    while not new_name:
        retry += 1
        if retry >= 3:
            print("输入超时，继续使用【%s】等待下次刷新..." % current_name)
            return current_name
        print("名称不能为空，请重新输入！")
        new_name = _safe_input("请输入新的主播名称: ").strip()
    # 保存新配置（保留原有刷新间隔）
    save_config(new_name, current_refresh)
    log("主播已切换为：【%s】" % new_name)
    # 清理旧缓存，防止读取到上个主播的数据
    clear_cache_file()
    return new_name


# ===================== 数据查询（async） =====================
async def get_anchor_single_data(anchor_name):
    """调用scraper搜索接口，仅查询目标主播"""
    sys.path.insert(0, get_base_dir())
    from scraper import search_anchor_by_name, load_cache_item
    # 优先使用缓存
    cached_item = load_cache_item(anchor_name)
    if cached_item:
        log("缓存命中：" + anchor_name)
        return cached_item
    log("调用官网搜索框查询主播：" + anchor_name)
    anchor_info = await search_anchor_by_name(anchor_name)
    if anchor_info:
        log("主播数据查询成功")
    else:
        log("未检索到该主播")
    return anchor_info


# ===================== 文本生成 =====================
def build_text(anchor_data, anchor_name):
    """OBS展示文本格式化"""
    if not anchor_data:
        return "未找到参赛主播「%s」\n请回到控制台窗口重新输入ID" % anchor_name
    update_time = time.strftime("%m-%d %H:%M:%S")
    return (
        "【%s】%s\n"
        "总排名：第 %s 名\n"
        "仓库总价值：%s\n"
        "击败干员数：%s\n"
        "破译曼德尔砖：%s\n"
        "参赛总局数：%s\n"
        "更新时间：%s"
        % (
            anchor_data.get("userName", ""),
            anchor_data.get("platName", ""),
            anchor_data.get("rankwid", "-"),
            anchor_data.get("warehouseValue", "0"),
            anchor_data.get("defeatedAgents", "0"),
            anchor_data.get("decryptedBricks", "0"),
            anchor_data.get("totalRounds", "0"),
            update_time,
        )
    )


def write_txt(content):
    """写入OBS文本文件（原子写入，防止OBS读到半写文件）"""
    full_path = _output_txt_path()
    tmp_path = full_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, full_path)
        log("数据已写入文件：" + full_path)
    except Exception as e:
        log("写入文件失败: %s" % e)


# ===================== 主程序 =====================
async def run_async(anchor_name, refresh_minutes):
    """异步主循环：所有 async 操作在同一个事件循环中运行"""
    sys.path.insert(0, get_base_dir())
    from scraper import init_browser, close_browser
    # 初始化浏览器（只开一次）
    await init_browser()
    log("浏览器预加载完成")
    log("=" * 50)
    log("OBS巅峰赛排名挂件启动 | 定向搜索模式")
    log("追踪主播：【%s】 | 刷新间隔：%d分钟" % (anchor_name, refresh_minutes))
    log("OBS文本文件：" + _output_txt_path())
    log("=" * 50)
    try:
        while True:
            start_time = time.time()
            # 1. 查询数据
            anchor_info = await get_anchor_single_data(anchor_name)
            # 2. 如果没找到，触发重配置（不关闭程序，不重启浏览器）
            if not anchor_info:
                old_name = anchor_name
                log("检测到主播【%s】不存在，进入重配置..." % anchor_name)
                anchor_name = reconfigure_anchor(refresh_minutes, anchor_name)
                if anchor_name == old_name:
                    # 名字没变（用户未输入新名），等待一段时间再重试
                    log("名称未变更，60秒后重试...")
                    await asyncio.sleep(60)
                continue
            # 3. 正常显示数据
            display_text = build_text(anchor_info, anchor_name)
            write_txt(display_text)
            elapsed = time.time() - start_time
            next_sleep = (refresh_minutes * 60) - elapsed
            next_refresh = time.localtime(time.time() + max(next_sleep, 0))
            next_time_str = time.strftime("%H:%M:%S", next_refresh)
            log("本轮耗时: %.2fs，下次刷新：%s" % (elapsed, next_time_str))
            log("-" * 50)
            if next_sleep > 0:
                await asyncio.sleep(next_sleep)
    except KeyboardInterrupt:
        print()
        log("收到退出信号...")
    finally:
        # 确保退出时关闭浏览器
        await close_browser()
        log("程序已安全退出")


def main():
    """入口：配置交互（同步） → 数据循环（异步）"""
    # 1. 读取已有配置
    existing = load_config()
    # 2. 交互式配置
    if existing:
        anchor_name, refresh_minutes = prompt_config(existing[0], existing[1])
    else:
        anchor_name, refresh_minutes = prompt_config()
    # 3. 启动异步主循环（整个程序只有这一个 asyncio.run）
    try:
        asyncio.run(run_async(anchor_name, refresh_minutes))
    except KeyboardInterrupt:
        print("\n程序手动终止，退出成功")


if __name__ == "__main__":
    main()
