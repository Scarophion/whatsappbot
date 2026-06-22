const fs = require("fs/promises");
const path = require("path");
const puppeteer = require("puppeteer");
const { pathToFileURL } = require("url");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sum(values) {
  return (Array.isArray(values) ? values : []).reduce((total, value) => {
    const number = Number(value);
    return total + (Number.isFinite(number) ? number : 0);
  }, 0);
}

function listMarkup(values) {
  const safeValues = Array.isArray(values) ? values : [];
  if (safeValues.length === 0) {
    return '<p class="muted">None</p>';
  }

  const items = safeValues
    .map((value) => `<li>${escapeHtml(value)}</li>`)
    .join("");

  return `<ul class="list">${items}</ul>`;
}

function formatDateDMY(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();

  return `${day}/${month}/${year}`;
}

async function renderAndCapture({ html, screenshotPath, browser }) {
  if (!browser) {
    throw new Error("Browser instance is required for rendering.");
  }

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle0" });

    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    });

    const sheet = await page.$("#sheet");
    if (sheet) {
      await sheet.screenshot({ path: screenshotPath, type: "png" });
    } else {
      await page.screenshot({ path: screenshotPath, type: "png", fullPage: true });
    }
  }
  catch (error) {
    console.error("Error during renderAndCapture:", error);
    throw error;
  } finally {
    await page?.close();
  }
}

async function renderScoreSheetHtml(scoreSheet) {
  const logoPath = path.join(__dirname, "MSL_logo_500x500.png");

  let logoUrl = "";
  try {
    const imageBuffer = await fs.readFile(logoPath);
    logoUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;
  } catch (error) {
    console.error("Error reading logo:", error);
  }

  const innings = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const headerCells = ["Team", ...innings, "Final"]
    .map((label) => `<th scope="col">${label}</th>`)
    .join("");

  const rowMarkup = (teamName, values) => {
    const inningCells = values.map((value) => `<td>${escapeHtml(value)}</td>`).join("");
    return `
      <tr>
        <td>${escapeHtml(teamName)}</td>
        ${inningCells}
        <td class="total">${escapeHtml(sum(values))}</td>
      </tr>
    `;
  };

  const metaItems = [
    ["Field", scoreSheet.field],
    ["Home Elect To Bat 1st", scoreSheet.homeBatsFirst ? "YES" : "NO"],
    ["Umpire", scoreSheet.umpire]
  ];

  const metaGrid = metaItems
    .map(
      ([label, value]) => `
      <div class="meta-cell">
        <span class="meta-label">${escapeHtml(label)}</span>
        <span class="meta-value">${escapeHtml(value)}</span>
      </div>
    `
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MSL Score Sheet - Submission View</title>
<style>
    :root {
      --bg-top: #f7dfd8;
      --bg-bottom: #f8f1ec;
      --card: #ffffff;
      --ink: #2f201d;
      --muted: #6f504a;
      --line: #e5c8c2;
      --accent: #c23f25;
      --accent-soft: #f7e4df;
      --warn-soft: #fff2d9;
      --radius: 14px;
      --shadow: 0 10px 30px rgba(63, 20, 13, 0.11);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      font-size: 1.25rem;
      color: var(--ink);
      background: linear-gradient(160deg, var(--bg-top), var(--bg-bottom));
      min-height: 100vh;
      padding: 28px 16px;
    }

    .page {
      max-width: 1160px;
      margin: 0 auto;
    }

    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }

    .toolbar h1 {
      margin: 0;
      font-size: clamp(1.1rem, 1.6vw + 0.8rem, 1.9rem);
      letter-spacing: 0.02em;
    }

    #sheet {
      background: var(--card);
      border-radius: 22px;
      box-shadow: var(--shadow);
      border: 1px solid rgba(194, 63, 37, 0.28);
      overflow: hidden;
    }

    .section {
      padding: 20px;
      border-bottom: 1px solid var(--line);
    }

    .section:last-child {
      border-bottom: none;
    }

    h2 {
      margin: 0 0 14px;
      // font-size: 1.06rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--accent);
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(150px, 1fr));
      gap: 12px;
    }

    .meta-cell {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fbfdff;
      padding: 10px;
    }

    .meta-label {
      // font-size: 0.74rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .meta-value {
      font-weight: 600;
      min-height: 20px;
    }

    .inning-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 840px;
    }

      th,
      td {
          border: 1px solid var(--line);
          text-align: center;
          padding: 9px 6px;
          font-size: 2.5em;
      }

    th:first-child,
    td:first-child {
      text-align: left;
/*      min-width: 158px;*/
      padding-left: 10px;
      font-weight: 600;
    }

    th {
      background: var(--accent-soft);
      color: #5a251b;
    }

    td.total {
      font-weight: 700;
      background: #fbece9;
    }

    .details-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(220px, 1fr));
      gap: 14px;
    }

    .detail-card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 14px;
      background: #fcfeff;
    }

    .detail-card h3 {
      margin: 0 0 10px;
      // font-size: 0.98rem;
      color: #7a2f1f;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .label {
      // font-size: 0.78rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 10px 0 6px;
    }

    .list {
      margin: 0;
      padding-left: 18px;
    }

    .list li {
      margin: 4px 0;
    }

    .note-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(220px, 1fr));
      gap: 14px;
    }

    .note {
      border-radius: var(--radius);
      border: 1px solid var(--line);
      padding: 12px;
      background: #fcfeff;
      min-height: 110px;
    }

    .note.warn {
      background: var(--warn-soft);
    }

    .muted {
      color: var(--muted);
    }

    @media (max-width: 860px) {
      .meta-grid,
      .details-grid,
      .note-grid {
        grid-template-columns: 1fr;
      }

      body {
        padding: 14px 10px;
      }

      .section {
        padding: 14px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <h1>Manchester Softball League - Score Sheet Submission View</h1>
      <p>Generated automatically for WhatsApp delivery.</p>
    </div>

    <article id="sheet" aria-label="MSL score sheet submission view">
      <section class="section">
        <div class="toolbar">
                <div style="display:flex; align-items:center; gap:6px;"">
              <img src="${logoUrl}" width="50" height="50"" />
                    <div>
                        <h2 style="margin:0;">${escapeHtml(formatDateDMY(scoreSheet.dateOfGame))}</h2>
                        <h1>${escapeHtml(scoreSheet.awayTeam)} @ ${escapeHtml(scoreSheet.homeTeam)}</h1>
                    </div>
                </div>
            </div>
        <div class="meta-grid">${metaGrid}</div>
      </section>

      <section class="section">
        <div class="inning-wrap">
          <table aria-label="Score by inning">
            <thead>
              <tr>${headerCells}</tr>
            </thead>
            <tbody>
              ${rowMarkup(scoreSheet.scoreByInning.battingFirstTeam, scoreSheet.scoreByInning.battingFirst)}
              ${rowMarkup(scoreSheet.scoreByInning.battingSecondTeam, scoreSheet.scoreByInning.battingSecond)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <!--<h2>Game Details</h2>-->
        <div class="details-grid">
          <section class="detail-card" aria-label="Team Batting 1st">
            <h3>Team Batting 1st</h3>
            <div class="label">Home Runs</div>
            ${listMarkup(scoreSheet.gameDetails.battingFirst.homeRuns)}
            <div class="label">MVPs</div>
            <p><strong>SBH MVP:</strong> ${escapeHtml(scoreSheet.gameDetails.battingFirst.sbhMvp)}</p>
            <p><strong>BBH MVP:</strong> ${escapeHtml(scoreSheet.gameDetails.battingFirst.bbhMvp)}</p>
          </section>

          <section class="detail-card" aria-label="Team Batting 2nd">
            <h3>Team Batting 2nd</h3>
            <div class="label">Home Runs</div>
            ${listMarkup(scoreSheet.gameDetails.battingSecond.homeRuns)}
            <div class="label">MVPs</div>
            <p><strong>SBH MVP:</strong> ${escapeHtml(scoreSheet.gameDetails.battingSecond.sbhMvp)}</p>
            <p><strong>BBH MVP:</strong> ${escapeHtml(scoreSheet.gameDetails.battingSecond.bbhMvp)}</p>
          </section>
        </div>
      </section>

      <section class="section">
        <!--<h2>Additional Notes</h2>-->
        <div class="note-grid">
          <section class="note">
            <div class="label">Other Mentions</div>
            <p>${escapeHtml(scoreSheet.notes.otherPlayersAndPlays)}</p>
          </section>

          <section class="note warn">
            <div class="label">Serious Injuries</div>
            <p>${escapeHtml(scoreSheet.notes.seriousInjuries)}</p>
          </section>

          <section class="note">
            <div class="label">Reason for Incomplete Game</div>
            <p>${escapeHtml(scoreSheet.notes.incompleteReason)}</p>
          </section>
        </div>
      </section>
    </article>
  </div>
</body>
</html>`;
}

module.exports = {
  renderAndCapture,
  renderScoreSheetHtml
};
