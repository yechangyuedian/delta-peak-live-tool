# 三角洲巅峰赛 OBS 排名挂件

三角洲行动主播巅峰赛实时排名查询工具，配合 OBS 直播使用，自动定时更新主播排名数据。

## 功能特点

- 🎯 **精准查询**：通过官网搜索框定向搜索主播，无需爬取全量榜单
- 🔄 **自动刷新**：可配置刷新间隔，定时自动更新排名数据
- 📦 **缓存机制**：5分钟本地缓存，减少重复请求
- 🌐 **浏览器自动探测**：自动识别 Chrome / Edge / Playwright 内置浏览器
- ⚙️ **配置持久化**：主播名称和刷新间隔自动保存到 config.ini
- 📝 **原子写入**：防止 OBS 读取到不完整的文本文件

## 数据展示

OBS 读取 `obs_rank_display.txt` 文件，显示内容包括：
- 主播名称 + 平台
- 总排名
- 仓库总价值
- 击败干员数
- 破译曼德尔砖数
- 参赛总局数
- 更新时间

## 环境要求

- Python 3.8+
- Chrome 或 Edge 浏览器（推荐）

## 安装使用

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 安装 Playwright 浏览器

```bash
playwright install chromium
```

### 3. 运行程序

```bash
python obs_rank.py
```

首次运行会提示输入主播名称和刷新间隔，配置会自动保存。

### 4. OBS 配置

1. 在 OBS 中添加「文本（GDI+）」来源
2. 勾选「从文件读取」
3. 选择程序目录下的 `obs_rank_display.txt`
4. 设置合适的字体、颜色和位置

## 文件说明

| 文件 | 说明 |
|------|------|
| `obs_rank.py` | 主程序入口，OBS 排名显示逻辑 |
| `scraper.py` | 数据抓取模块，Playwright 页面渲染与搜索 |
| `requirements.txt` | Python 依赖清单 |
| `config.ini` | 运行后生成，保存主播配置 |
| `obs_rank_display.txt` | 运行后生成，OBS 读取的文本文件 |
| `delta_rank_cache.json` | 运行后生成，数据缓存 |
| `obs_rank.log` | 运行后生成，运行日志 |

## 打包为 EXE

使用 PyInstaller 打包：

```bash
pyinstaller -F -n delta-peak-rank obs_rank.py
```

## 注意事项

- 建议刷新间隔不低于 5 分钟，避免给官网服务器造成压力
- 本工具仅供学习交流使用，请遵守目标网站的使用条款
- 主播名称需与巅峰赛榜单上显示的名称完全一致

## 免责声明

本项目仅用于学习和研究目的，使用者需自行承担使用风险。
