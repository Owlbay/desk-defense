// 书桌防线桌面壳：只是一个加载 dist/ 的 WebView 窗口，游戏逻辑全部在前端。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
