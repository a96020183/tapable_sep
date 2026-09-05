# 測試

vision 事件引擎回歸（Playwright，headless；以 `window.__V.evaluate()` 注入合成偵測，不需真相機）：

```bash
npm i playwright            # 使用系統 Edge/Chrome（channel:'msedge'）
python -m http.server 4188  # 在 repo 根目錄
node tests/vision/v2-spec1_priority.js   # 單一播報＋優先序
node tests/vision/v2-spec2_vehicle.js    # 逼近偵測（同向／靜止不報）
node tests/vision/v2-spec4_obstacle.js   # 室內障礙物
node tests/vision/v2-spec5_gating.js     # P0 信心與連續幀門檻
node tests/vision/v2-feedback_bugs.js    # 多實例去重
```

每支腳本逐行輸出 `PASS | 編號 | 說明`。抵達交棒流程另需以假相機餵 QR 影像，見腳本註解。
