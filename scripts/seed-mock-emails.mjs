// Host-side dev helper. nodemailer is a devDependency and this file is not copied
// into the image. Run it on the host: node scripts/seed-mock-emails.mjs
import nodemailer from "nodemailer";

const smtpPort = Number.parseInt(process.env.SMTP_PORT || "2525", 10);
const smtpHost = process.env.SMTP_HOST || "127.0.0.1";

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: false,
  tls: { rejectUnauthorized: false },
});

const samples = [
  {
    from: '"Security Alert" <alert@microsoft-security-verify.net>',
    to: "admin@example.com",
    subject: "【紧急安全告警】您的组织账号密码已过期，请在 24 小时内验证",
    text: "尊敬的管理员：系统检测到您的微软办公套件存在异常登录。请立即点击下方链接验证身份以避免账号被停用：https://microsoft-security-verify.net/auth/login",
    html: `
      <div style="font-family:sans-serif;max-width:540px;margin:auto;padding:24px;border:1px solid #e1e4e8;border-radius:8px;">
        <h2 style="color:#d93025;margin-top:0;">⚠️ 组织安全中心警告</h2>
        <p>尊敬的用户 <b>admin@example.com</b>：</p>
        <p>我们检测到来自非常用 IP 地址（185.220.101.5）的异常凭据验证请求。</p>
        <p style="background:#fff3cd;padding:12px;border-left:4px solid #ffeeba;color:#856404;">
          如果不立即处理，您的企业组织账号及关联邮箱将于 <b>24 小时后被强制锁定</b>。
        </p>
        <p style="text-align:center;margin:24px 0;">
          <a href="https://microsoft-security-verify.net/auth/login?user=admin" style="background:#0067b8;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold;display:inline-block;">
            立即验证并更新安全凭证
          </a>
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
        <small style="color:#6a737d;">此邮件由企业安全网关自动下发，请勿直接回复。</small>
      </div>
    `,
  },
  {
    from: '"GitHub Notifications" <notifications@github.com>',
    to: "dev@example.com",
    subject: "[GoogleDeepMind/flytrap] Pull Request #14: Implement v0.3 Modern Dashboard",
    text: "flytrap-bot merged commit 8fa239 into main.\nView pull request: https://github.com/GoogleDeepMind/flytrap/pull/14",
    html: `
      <div style="font-family:sans-serif;color:#24292e;padding:16px;">
        <p style="font-size:16px;"><b>flytrap-bot</b> merged pull request <b>#14</b> into <code>main</code>.</p>
        <div style="background:#f6f8fa;border:1px solid #d1d5da;padding:16px;border-radius:6px;margin:16px 0;">
          <h4 style="margin:0 0 8px;">v0.3 Modern Dashboard & Robust AI Engine</h4>
          <p style="margin:0;color:#586069;font-size:14px;">- Replaced olive green theme with sleek dark/light dual mode.<br>- Added Sandboxed HTML preview.<br>- Added Dead Letter Queue auto-healing.</p>
        </div>
        <p><a href="https://github.com/GoogleDeepMind/flytrap/pull/14" style="color:#0366d6;text-decoration:none;">View PR on GitHub →</a></p>
      </div>
    `,
  },
  {
    from: '"Global SEO & Marketing" <contact@top-rankings-agency.biz>',
    to: "webmaster@example.com",
    subject: "Exclusive Offer: Boost your domain authority and organic traffic by 300%",
    text: "Hi Webmaster,\nWe noticed your domain rank can be improved. Get 100 high DA backlinks for only $99.\nUnsubscribe: https://top-rankings-agency.biz/unsub",
    html: `
      <div style="font-family:sans-serif;padding:16px;color:#333;">
        <h3>Want more traffic to example.com?</h3>
        <p>We provide verified backlink services, guaranteed index in 48 hours.</p>
        <p>Special price today: <b>$99 only</b>!</p>
        <p><a href="https://top-rankings-agency.biz/buy?ref=example.com" style="color:#e65100;">Claim discount now</a></p>
      </div>
    `,
  },
  {
    from: '"Finance Dept" <payroll@payroll-direct-service.cc>',
    to: "admin@example.com",
    subject: "2026年9月份员工薪酬明细单及个人所得税退税申报表",
    text: "各位同事：请查收本月个税申报附件，点击链接确认退税账户：http://payroll-direct-service.cc/tax-refund",
    html: `
      <div style="font-family:sans-serif;padding:20px;border:1px solid #ccc;">
        <h3>2026 年度个人所得税汇算清缴确认通知</h3>
        <p>根据税务局最新规定，您有一笔退税待确认。请通过以下通道提交：</p>
        <p><a href="http://payroll-direct-service.cc/tax-refund">点击进入退税快速通道</a></p>
      </div>
    `,
  },
];

async function main() {
  console.log(`Connecting to SMTP at ${smtpHost}:${smtpPort}...`);
  let failed = 0;
  try {
    for (const mail of samples) {
      try {
        const info = await transporter.sendMail(mail);
        console.log(`Sent: "${mail.subject}" -> ${info.messageId}`);
      } catch (err) {
        failed += 1;
        console.error(`Failed to send "${mail.subject}":`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    transporter.close();
  }
  if (failed > 0) {
    console.error(`${failed} of ${samples.length} mock emails failed`);
    process.exitCode = 1;
    return;
  }
  console.log("Mock emails sent successfully!");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
