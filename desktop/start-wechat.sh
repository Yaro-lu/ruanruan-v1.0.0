#!/bin/bash
set -eu
# Keep desktop input helpers in the desktop processes. The official WeChat
# client runs without inherited Selkies joystick / fake-udev preloads.
mkdir -p /config/Desktop /config/.config/openbox
if [ ! -f /config/.config/openbox/rc.xml ]; then
  cp /etc/xdg/openbox/rc.xml /config/.config/openbox/rc.xml
fi
cat > /config/Desktop/微信.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=微信
Exec=env -u LD_PRELOAD /usr/bin/wechat
Icon=wechat
Terminal=false
EOF
/scripts/refresh-menu.sh
stalonetray --dockapp-mode simple >/dev/null 2>&1 &
exec env -u LD_PRELOAD /usr/bin/wechat
