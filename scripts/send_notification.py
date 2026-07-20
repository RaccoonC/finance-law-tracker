#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
send_notification.py（財務法規追蹤系統版）

用途：
    讀取本次執行產生的 data/laws-data.json，找出「這次才新偵測到」的
    法規異動（newly_detected）與新出現的抓取失敗（newly_error）——
    這兩個旗標是在 scripts/update-laws.mjs 抓取階段就算好的，避免
    同一件事連續好幾天都寄信。如果有任何新項目，寄一封彙整 Email
    通知信；如果沒有，就什麼都不做。

    跟人事法規追蹤系統的版本邏輯完全一致，差別只在：
    1. 讀的是 data/laws-data.json（不是 laws_status.json）
    2. 沒有新聞追蹤功能，所以拿掉新聞那段
    3. 連結欄位叫 url（不是 view_url）

需要的環境變數（在 GitHub Actions 的 workflow 裡以 secrets 帶入，
跟人事系統用同一組值即可）：
    MAIL_USERNAME   寄件信箱帳號（例如 Gmail 帳號）
    MAIL_PASSWORD   寄件信箱的應用程式密碼（不是一般登入密碼）
    MAIL_TO         收件信箱，可用逗號分隔多個地址
    MAIL_SMTP_HOST  （選填）SMTP 主機，預設 smtp.gmail.com
    MAIL_SMTP_PORT  （選填）SMTP 連接埠，預設 465（SSL）

    如果 MAIL_USERNAME / MAIL_PASSWORD / MAIL_TO 任何一個沒有設定，
    這支腳本會印出提醒訊息並直接結束，不會讓整個 workflow 失敗。
"""

import json
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAWS_DATA_PATH = os.path.join(BASE_DIR, "data", "laws-data.json")
NEWS_FEED_PATH = os.path.join(BASE_DIR, "data", "news-feed.json")
QA_DATA_PATH = os.path.join(BASE_DIR, "data", "qa-data.json")

SMTP_HOST = os.environ.get("MAIL_SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("MAIL_SMTP_PORT", "465"))

DASHBOARD_URL = "https://finance-law-tracker.tierhr.workers.dev/"


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return default


def build_email_html(newly_laws, newly_errors, newly_news):
    parts = []
    parts.append("<div style='font-family:sans-serif;font-size:14px;color:#1a2035;line-height:1.7'>")
    parts.append("<h2 style='color:#1a2a4a'>財務法規追蹤系統 · 異動通知</h2>")

    if newly_laws:
        parts.append("<h3 style='color:#c0392b'>🔴 偵測到法規異動</h3><ul>")
        for law in newly_laws:
            date_str = law.get("last_amend_date") or law.get("publish_date") or "（日期未知）"
            url = law.get("url") or "#"
            parts.append(
                f"<li><a href='{url}'>{law['name']}</a>"
                f"（{law.get('category','未分類')}）— {date_str}</li>"
            )
        parts.append("</ul>")

    if newly_errors:
        parts.append("<h3 style='color:#b07a10'>⚪ 新出現的抓取失敗／需人工確認</h3><ul>")
        for law in newly_errors:
            parts.append(f"<li>{law['name']} — {law.get('fetch_error','')}</li>")
        parts.append("</ul>")

    if newly_news:
        parts.append("<h3 style='color:#1a2a4a'>📰 新出現的相關新聞</h3><ul>")
        for n in newly_news[:20]:
            parts.append(
                f"<li><a href='{n['link']}'>{n['title']}</a>"
                f"（關鍵字：{n.get('keyword','')}｜來源：{n.get('source','')}）</li>"
            )
        parts.append("</ul>")
        if len(newly_news) > 20:
            parts.append(f"<p style='color:#6b7280'>...等共 {len(newly_news)} 則，其餘請至網站查看。</p>")

    parts.append(
        "<p style='color:#6b7280;font-size:12px;margin-top:20px'>"
        "此為系統自動寄送之通知信，如需查看完整清單與詳細資訊，請點擊下方按鈕。"
        "全國法規資料庫每週五才整批更新，實際異動頻率約為每週一次。"
        "</p>"
    )
    parts.append(
        f"<p style='margin:8px 0 0'><a href='{DASHBOARD_URL}' "
        "style='display:inline-block;background:#1a2a4a;color:#ffffff;text-decoration:none;"
        "padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600'>財務法規追蹤系統網頁 →</a></p>"
    )
    parts.append("</div>")
    return "".join(parts)


def main():
    mail_user = os.environ.get("MAIL_USERNAME")
    mail_pass = os.environ.get("MAIL_PASSWORD")
    mail_to = os.environ.get("MAIL_TO")

    if not mail_user or not mail_pass or not mail_to:
        print("尚未設定 MAIL_USERNAME / MAIL_PASSWORD / MAIL_TO 其中一項，略過寄信。")
        return

    laws_data = load_json(LAWS_DATA_PATH, {"laws": []})
    news_feed = load_json(NEWS_FEED_PATH, {"items": []})
    qa_data = load_json(QA_DATA_PATH, {"items": []})

    all_laws = laws_data.get("laws", []) + qa_data.get("items", [])
    newly_laws = [l for l in all_laws if l.get("newly_detected")]
    newly_errors = [l for l in all_laws if l.get("newly_error")]
    newly_news = [n for n in news_feed.get("items", []) if n.get("first_seen_this_run")]

    if not newly_laws and not newly_errors and not newly_news:
        print("本次執行沒有偵測到新的法規異動、抓取失敗或新聞，不寄送通知信。")
        return

    subject_parts = []
    if newly_laws:
        subject_parts.append(f"{len(newly_laws)} 筆法規異動")
    if newly_news:
        subject_parts.append(f"{len(newly_news)} 則新聞")
    if newly_errors:
        subject_parts.append(f"{len(newly_errors)} 筆抓取失敗")
    subject = "【財務法規追蹤】" + "、".join(subject_parts) + f"（{datetime.now().strftime('%Y-%m-%d')}）"

    html_body = build_email_html(newly_laws, newly_errors, newly_news)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = mail_user
    msg["To"] = mail_to
    msg["Date"] = formatdate(localtime=True)
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    recipients = [addr.strip() for addr in mail_to.split(",") if addr.strip()]

    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=30) as server:
            server.login(mail_user, mail_pass)
            server.sendmail(mail_user, recipients, msg.as_string())
        print(f"通知信已寄出，收件人：{mail_to}")
    except Exception as e:  # noqa: BLE001
        # 寄信失敗不應該讓整個 workflow 失敗（資料抓取跟 commit 還是要正常跑），
        # 這裡只印出錯誤訊息，讓你在 Actions 執行紀錄裡看得到。
        print(f"寄送通知信失敗：{e}")


if __name__ == "__main__":
    main()
