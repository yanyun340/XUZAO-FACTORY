@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 序造 XuZao - 开发服务

echo ============================================
echo   序造 XuZao 开发栈启动中
echo   db:55432  ^-^>  api:3001  ^-^>  web:5173
echo   首次启动需 15~30 秒，浏览器会自动打开
echo   关闭本窗口即停止全部服务
echo ============================================
echo.

start "" cmd /c "for /l %%i in (1,1,90) do (curl -s -o nul http://localhost:5173 && (start http://localhost:5173 & exit) || timeout /t 2 >nul)"

call npm run dev

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul