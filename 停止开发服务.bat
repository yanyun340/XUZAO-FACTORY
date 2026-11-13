@echo off
chcp 65001 >nul
title 序造 XuZao - 停止服务

for %%p in (5173 3001 55432) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%%p .*LISTENING"') do (
    echo 结束端口 %%p 的进程 PID %%a
    taskkill /PID %%a /F >nul 2>&1
  )
)
echo.
echo 已尝试停止 db / api / web 三个服务。
timeout /t 2 >nul