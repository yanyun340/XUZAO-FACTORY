@echo off
chcp 65001 >nul
cd /d "%~dp0"
title XuZao dev
node "scripts\launch.mjs"
echo.
echo Service stopped. Press any key to close.
pause >nul
