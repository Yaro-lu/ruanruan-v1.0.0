"""Short deployment handoff; receiving keeps its existing durable cursor."""
import json
import math
import os
import time
from wechat_gui import DATA


def deployment_held(path=None):
    try:
        value=json.loads((path or DATA/'auto-repair/deploy-hold.json').read_text())
        if not isinstance(value,dict) or type(value.get('pid')) is not int or value['pid']<=0 or type(value.get('until')) not in (int,float) or not math.isfinite(value['until']) or value['until']<=time.time()*1000:
            return False
        try:os.kill(value['pid'],0)
        except PermissionError:return True
        return True
    except (OSError,ValueError,TypeError,OverflowError):return False
