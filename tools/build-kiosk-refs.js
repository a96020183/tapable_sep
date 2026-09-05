// 用法：把實拍機台照片放到 <repo>/_qa_photos/（不進 git），在 repo 根目錄 python -m http.server 4182，
// 然後 node tools/build-kiosk-refs.js → 輸出 kiosk-refs.new.json（門檻依正負樣本 margin 決定，本作品採 0.72）。
// 照片本體含個資，絕不提交。
