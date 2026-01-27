@echo off
chcp 65001 > nul
title 日報システム - 停止

echo ========================================
echo   日報システム 停止
echo ========================================
echo.

REM Node.jsプロセスを検索して停止
tasklist /fi "imagename eq node.exe" | find "node.exe" >nul
if %errorlevel% equ 0 (
    echo Node.jsプロセスを停止しています...
    taskkill /f /im node.exe >nul 2>&1
    echo [完了] サーバーを停止しました
) else (
    echo [情報] 起動中のサーバーはありません
)

echo.
pause
