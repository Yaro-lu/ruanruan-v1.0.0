@echo off
chcp 65001 >nul
ssh -T DEPLOY_USER@SERVER python3 /ABSOLUTE/PATH/TO/ruanruan/desktop/manual_control.py release
pause
