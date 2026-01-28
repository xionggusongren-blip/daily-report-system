@echo off
title Stop Server

echo ========================================
echo   Stopping Server...
echo ========================================
echo.

tasklist /fi "imagename eq node.exe" 2>nul | find /i "node.exe" >nul
if %errorlevel% equ 0 (
    echo Stopping Node.js process...
    taskkill /f /im node.exe >nul 2>&1
    echo [OK] Server stopped.
) else (
    echo [INFO] No server running.
)

echo.
pause
