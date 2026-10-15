# Liman

Minimal, sade bir SSH + SFTP istemcisi (Windows & macOS). Termius'tan esinlenildi; odak noktası kullanım kolaylığı.

## Özellikler

- **Sürükle-bırak yükleme:** Masaüstünden/Explorer/Finder'dan dosya veya klasörü terminale bırakın — terminal o an hangi dizindeyse oraya yüklenir. Bırakmadan önce hedef dizin ekranda gösterilir.
- **SFTP paneli:** Gezinme, klasöre bırakarak yükleme, çift tıkla indirme (İndirilenler klasörüne), yeniden adlandırma, silme, yeni klasör, "terminalin bulunduğu dizine git".
- **Çakışma kontrolü:** Aynı isimde dosya varsa sorar: *Keep both* (`dosya (1).txt`) / *Replace* / *Cancel*.
- **Açık / koyu / sistem teması**, terminal yazı boyutu ayarı.
- **Kimlik doğrulama:** parola, SSH anahtarı (parolalı anahtar dahil), SSH agent, klavye-etkileşimli (2FA).
- **Güvenlik:** Host key parmak izi ilk bağlantıda onaylanır, değişirse uyarılır. Parolalar işletim sisteminin anahtar zinciriyle (`safeStorage`) şifrelenir.
- Sekmeler, hızlı bağlan (`kullanici@sunucu:port` yazıp Enter), sağ tık ile kopyala/yapıştır.

## Geliştirme

```bash
npm install
npm run dev          # geliştirme modunda çalıştır
npm run typecheck
npm run dist:win     # Windows kurulum dosyası (release/)
npm run dist:mac     # macOS .dmg — macOS üzerinde çalıştırılmalı
```

## Kısayollar

| İşlem | Windows | macOS |
|---|---|---|
| Kopyala / Yapıştır | Ctrl+C (seçim varsa) / Ctrl+V, ya da sağ tık | Cmd+C / Cmd+V |
| Sekme kapat | Ctrl+Shift+W | Cmd+W |
| Sekme değiştir | Ctrl+Tab, Ctrl+1…9 | Ctrl+Tab, Cmd+1…9 |

## Terminal dizini nasıl bulunuyor?

Kabuk, PID'si önceden öğrenilecek şekilde başlatılır (`src/main/ssh.ts`, `SHELL_BOOTSTRAP`). Dosya bırakıldığında ayrı bir SSH kanalı üzerinden terminalin ön plandaki sürecinin çalışma dizini okunur (Linux'ta `/proc`, macOS/BSD'de `lsof`). Terminale hiçbir şey yazılmaz. Bu mümkün olmazsa kabuğun gönderdiği OSC 7 bilgisine, o da yoksa ev dizinine düşülür.

## Yapı

```
src/main/      Electron ana süreç: SSH/SFTP motoru (ssh2), ayar ve host deposu
src/preload/   Renderer'a açılan güvenli API
src/renderer/  React arayüzü (xterm.js terminal)
src/shared/    Ortak tipler
```
