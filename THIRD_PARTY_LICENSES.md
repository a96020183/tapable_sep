# 第三方元件與授權（Third-party notices）

本作品自身以 MIT 授權（見 LICENSE）。以下為隨頁面自帶（vision/lib、vision/model、vision/kiosk）之第三方元件；Apache-2.0 全文見 `vision/lib/licenses/Apache-2.0.txt`，MIT 見 `vision/lib/licenses/MIT-qrcode-generator.txt`。

| 元件 | 版本 | 授權 | 來源 |
|---|---|---|---|
| TensorFlow.js（tf.min.js） | 4.22.0 | Apache-2.0 | https://github.com/tensorflow/tfjs |
| @tensorflow-models/coco-ssd（coco-ssd.min.js） | 2.2.3 | Apache-2.0 | https://github.com/tensorflow/tfjs-models |
| SSDLite-MobileNetV2 權重（vision/model/） | tfjs-models | Apache-2.0（COCO 預訓練） | https://github.com/tensorflow/tfjs-models |
| MobileNet v1 0.25 權重（vision/kiosk/，外觀比對嵌入） | tfjs-models | Apache-2.0 | https://github.com/tensorflow/tfjs-models |
| jsQR（jsQR.js） | 1.4.0 | Apache-2.0 | https://github.com/cozmo/jsQR |
| qrcode-generator（qrcode.js） | 1.4.4 | MIT | https://github.com/kazuhikoarase/qrcode-generator |
| Web Speech API（TTS／ASR） | 瀏覽器內建 | — | — |

`vision/kiosk-refs.json` 為本團隊以實拍照片自行產生之特徵向量（照片本體不隨 repo 提供），產生流程見 `tools/build-kiosk-refs.js`。
