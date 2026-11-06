#!/bin/bash
set -euo pipefail
# Only this desktop's fixed subnet is affected. Model/service traffic is unchanged.
subnet=10.203.77.0/24
bridge=br-rr-wechat
physical=$(ip -4 -j route show default table main | python3 -c 'import json,sys; r=json.load(sys.stdin); print(next(x["dev"] for x in r if x.get("gateway")))')
case "$physical" in Meta|tun*|tap*|wg*|tailscale*|vpn*) echo 'No physical default route available' >&2; exit 1;; esac

add_rule() {
  local priority=$1
  shift
  if ip -4 rule show priority "$priority" | grep -q .; then
    ip -4 rule show priority "$priority" | grep -q 'from 10.203.77.0/24' || { echo "Routing priority $priority is occupied" >&2; exit 1; }
  else
    ip -4 rule add priority "$priority" from "$subnet" "$@"
  fi
}
# Private desktop-control replies can return over Tailscale; WeChat public
# connections use the physical main route before any Mihomo/TUN rules.
add_rule 1700 to 100.64.0.0/10 lookup 52
add_rule 1701 lookup main

iptables -w -N RR_WECHAT_DIRECT 2>/dev/null || true
iptables -w -F RR_WECHAT_DIRECT
iptables -w -A RR_WECHAT_DIRECT -o "$physical" -j RETURN
iptables -w -A RR_WECHAT_DIRECT -o tailscale0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A RR_WECHAT_DIRECT -j REJECT
iptables -w -C DOCKER-USER -i "$bridge" -j RR_WECHAT_DIRECT 2>/dev/null || iptables -w -I DOCKER-USER 1 -i "$bridge" -j RR_WECHAT_DIRECT
# A container must not reach a host proxy/TProxy socket instead of the ISP path.
iptables -w -C INPUT -i "$bridge" -m conntrack --ctstate NEW -j REJECT 2>/dev/null || iptables -w -I INPUT 1 -i "$bridge" -m conntrack --ctstate NEW -j REJECT
echo "WeChat desktop direct route: $subnet -> $physical"
