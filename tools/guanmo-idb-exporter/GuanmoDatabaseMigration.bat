@echo off
title Guanmo Database Migration Tool v1.0.0

echo.
echo  ========================================
echo     Guanmo Database Migration Tool
echo  ========================================
echo.

REM Get script directory
set "BASE_DIR=%~dp0"
set "BASE_DIR=%BASE_DIR:~0,-1%"

REM Check Node.js in portable package
set "NODE_EXE=%BASE_DIR%\node\node.exe"
if exist "%NODE_EXE%" (
    echo  Found portable Node.js
    goto :run
)

REM Check system Node.js
where node >nul 2>&1
if %errorlevel% equ 0 (
    set "NODE_EXE=node"
    echo  Found system Node.js
    goto :run
)

echo  [ERROR] Node.js not found
echo.
echo  Please ensure node.exe exists in:
echo    - node\ directory (portable)
echo    - System PATH
echo.
pause
exit /b 1

:run
REM Check app directory
set "APP_DIR=%BASE_DIR%\app"
if not exist "%APP_DIR%\index.js" (
    echo  [ERROR] Application files not found
    echo  Please ensure app\ directory exists
    pause
    exit /b 1
)

REM Run migration tool
echo  Starting migration tool...
echo.
cd /d "%APP_DIR%"
"%NODE_EXE%" index.js migrate

echo.
echo  ========================================
echo.
pause
