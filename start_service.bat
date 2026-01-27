@echo off
REM タスクスケジューラからバックグラウンドで起動するためのバッチ
REM ログはlogsフォルダに出力されます

REM バッチファイルのあるフォルダに移動
cd /d "%~dp0"

REM ログフォルダの作成
if not exist "logs" mkdir logs

REM 日付を取得
for /f "tokens=1-3 delims=/" %%a in ('date /t') do set LOGDATE=%%a%%b%%c
set LOGDATE=%LOGDATE: =%

REM node_modulesの確認
if not exist "node_modules" (
    echo [%date% %time%] パッケージをインストールしています... >> "logs\startup.log"
    call npm install >> "logs\startup.log" 2>&1
)

REM サーバー起動（ログファイルに出力）
echo [%date% %time%] サーバーを起動しました >> "logs\startup.log"
node "%~dp0app.js" >> "logs\server.log" 2>&1
