@echo off
REM ============================================================
REM 观墨数据迁移工具 (guanmo-migrate)
REM
REM 使用方法：
REM   guanmo-migrate.bat migrate          一键迁移（推荐）
REM   guanmo-migrate.bat detect           检测数据库位置
REM   guanmo-migrate.bat export           导出 IndexedDB
REM   guanmo-migrate.bat help             显示帮助
REM ============================================================

setlocal enabledelayedexpansion

REM 获取脚本所在目录
set "SCRIPT_DIR=%~dp0"

REM 检查 Node.js 是否可用
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ❌ 未找到 Node.js
    echo.
    echo 请先安装 Node.js:
    echo   https://nodejs.org/
    echo.
    echo 安装后请重新打开命令行窗口
    pause
    exit /b 1
)

REM 检查 node_modules 是否存在
if not exist "%SCRIPT_DIR%node_modules" (
    echo.
    echo ⚠️  首次运行，正在安装依赖...
    echo.
    cd /d "%SCRIPT_DIR%"
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
    echo.
)

REM 运行迁移工具
cd /d "%SCRIPT_DIR%"
node index.js %*

REM 如果没有参数，显示帮助
if "%~1"=="" (
    echo.
    node index.js --help
)

pause
