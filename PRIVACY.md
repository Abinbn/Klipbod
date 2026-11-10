# Privacy Policy for Klipbod

**Last Updated: November 10, 2026**

We take your privacy seriously. This Privacy Policy describes how **Klipbod** (the "Extension") handles your data. Because Klipbod is a local-only browser extension, your data belongs completely to you.

## 1. Information Collection and Use
Klipbod is designed to act as a local clipboard history manager.
* **Data Stored:** The extension captures text, links, and screenshots that you copy to your system clipboard, together with the time they were copied.
* **Local Storage Only:** All captured data is stored strictly within your browser's local sandbox storage using the Chrome Storage API.
* **No Remote Servers:** **We do not run external cloud servers.** Your clipboard history, clips, and images never leave your local device and are never transmitted across the internet.
* **No Accounts, No Analytics:** Klipbod does not require an account and does not include analytics, tracking pixels, advertising SDKs, or crash reporting.

## 2. Permissions Used
To function properly, Klipbod requests the following permissions from your browser:
* `storage`: Required to save your clipboard history, settings, and screenshots directly onto your machine. The history is capped at 50 items and Chrome's 10 MB local storage quota, and old items are deleted automatically.
* `clipboardRead`: Required so the extension can read what you copy and add it to your history. Chrome shows an install warning for this permission.
* `offscreen`: Required to run a hidden page (`offscreen.html`) that reads the clipboard. Background service workers cannot access the clipboard, and this hidden page is the only place where the extension reads it.
* `alarms`: Required to periodically check that the clipboard reader is running and restart it if it has stopped, so copying keeps working after the browser has been idle.

Klipbod does not request the `clipboardWrite` permission. Copying a clip back out of the popup uses the standard clipboard API from the popup itself, which does not require it.

## 3. What Is Read, and When
* While Chrome is running, Klipbod checks the system clipboard roughly every one to five seconds.
* That means it captures copies made in **other applications** and in **incognito windows** too, not only copies made in the tab you are looking at. This is how clipboard managers work, but you should know it before installing.
* Reading happens locally. The content is compared with what was stored before and either saved locally or ignored; it is never sent anywhere.
* Klipbod ignores whitespace-only copies, text longer than 500,000 characters, and images that cannot be decoded or made small enough to store; the popup explains when something was skipped.

## 4. Data Retention and Removal
* The history keeps the **50 most recent clips**. Older clips are deleted automatically.
* You can delete an individual clip with its trash icon at any time.
* **Clear all** in the popup deletes every saved clip immediately.
* Removing or uninstalling the extension removes all of its stored data with it.

## 5. Third-Party Services
Klipbod does not integrate with any third-party analytics trackers, advertising networks, or external databases. No data is shared with third parties. The extension makes no network requests.

## 6. Open Source and Integrity
Klipbod is completely free, transparent, and open-source under the **MIT License**. Anyone is welcome to inspect, review, or audit our full source code on our GitHub repository: `[Insert Link to GitHub Repository]`.

## 7. Changes to This Privacy Policy
We may update this Privacy Policy from time to time. Any updates will be pushed directly through extension updates on the Chrome Web Store and noted in this document.

## 8. Contact Us
If you have any questions, feedback, or concerns regarding your privacy, please feel free to open an issue on our GitHub repository or contact us at: **[Insert your public email address or contact link]**.
