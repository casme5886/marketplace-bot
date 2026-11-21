# Lug'atni (scripts/i18n_dict.py) web/app.html ichiga joylaydi: node scripts/build-app.mjs dan oldin ishga tushiring
import json, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from i18n_dict import D, MONTHS
ru, zh = {}, {}
for uz, r, z in D:
    k = re.sub(r"\d+(?:[.,:]\d+)*", "#", uz.strip())
    assert k.count("#") == r.count("#") == z.count("#"), (uz, r, z)
    ru[k] = r; zh[k] = z
obj = {"ru": ru, "zh": zh, "mon": MONTHS}
p = os.path.join(os.path.dirname(__file__), "..", "web", "app.html")
s = open(p, encoding="utf-8").read()
blk = "<!--I18N--><script>window.__I18N=" + json.dumps(obj, ensure_ascii=False).replace("</", "<\\/") + ";</script><!--/I18N-->"
if "<!--I18N-->" in s:
    s = re.sub(r"<!--I18N-->.*?<!--/I18N-->", lambda m: blk, s, flags=re.S)
else:
    i = s.index("<script>/*! QR Code")
    s = s[:i] + blk + "\n" + s[i:]
open(p, "w", encoding="utf-8").write(s)
print("i18n:", len(ru), "ta ibora")
