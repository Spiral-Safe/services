const OVERLAY_ID = "spiral-recording-overlay";
const STYLE_ID = "spiral-recording-safety-style";
const BADGE_ID = "spiral-recording-fixture-badge";
const TARGET_ATTRIBUTE = "data-spiral-recording-target";
const OVERLAY_MARGIN = 18;
const TARGET_CLEARANCE = 14;
const BADGE_CLEARANCE = 12;

export async function installRecordingSafety(
  page,
  fixtureLabel = "FIXTURE MODE · SYNTHETIC LOCAL DATA",
) {
  await page.evaluate(
    ({ styleId, badgeId, targetAttribute, label }) => {
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
        [data-recording-secret] {
          color: transparent !important;
          position: relative !important;
          text-shadow: none !important;
          user-select: none !important;
        }
        [data-recording-secret]::after {
          content: "REDACTED" !important;
          position: absolute !important;
          inset: 0 !important;
          display: grid !important;
          place-items: center start !important;
          color: #aeb7d8 !important;
          font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        }
        input[type="password"] {
          -webkit-text-security: disc !important;
        }
        [${targetAttribute}] {
          outline: 4px solid #62e6d2 !important;
          outline-offset: 5px !important;
          border-radius: 9px !important;
          box-shadow: 0 0 0 9px rgba(98, 230, 210, 0.18) !important;
          transition: outline-color 120ms ease, box-shadow 120ms ease !important;
        }
      `;
        document.documentElement.append(style);
      }
      if (!document.getElementById(badgeId)) {
        const badge = document.createElement("div");
        badge.id = badgeId;
        badge.textContent = label;
        badge.style.cssText = [
          "all:initial",
          "position:fixed",
          "left:18px",
          "bottom:18px",
          "z-index:2147483646",
          "pointer-events:none",
          "border:1px solid rgba(164,151,255,.78)",
          "border-radius:999px",
          "background:rgba(20,17,45,.94)",
          "box-shadow:0 10px 35px rgba(0,0,0,.28)",
          "color:#d9d3ff",
          "padding:8px 12px",
          "font:850 11px/1.2 Inter,ui-sans-serif,system-ui,sans-serif",
          "letter-spacing:.075em",
          "text-transform:uppercase",
        ].join(";");
        document.documentElement.append(badge);
      }
    },
    {
      styleId: STYLE_ID,
      badgeId: BADGE_ID,
      targetAttribute: TARGET_ATTRIBUTE,
      label: fixtureLabel,
    },
  );
}

export async function showAnnotatedStep(
  page,
  step,
  number,
  { fixtureLabel, screenshotPath, holdMs = 850 } = {},
) {
  await installRecordingSafety(page, fixtureLabel);
  await clearAnnotatedStep(page);
  const targetMatch = await firstVisibleTarget(page, [
    ...(step.targets || []),
    "body",
  ]);
  const target = targetMatch?.locator;
  if (target) {
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((element) => {
      if (element !== document.body && element !== document.documentElement) {
        element.scrollIntoView({ block: "center", inline: "nearest" });
      }
    });
    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: window.scrollY, behavior: "auto" });
    });
    await page.waitForTimeout(100);
    await target.evaluate((element, attribute) => {
      element.setAttribute(attribute, "true");
    }, TARGET_ATTRIBUTE);
  }
  const layout = await page.evaluate(
    ({
      overlayId,
      badgeId,
      targetAttribute,
      numberValue,
      section,
      title,
      description,
    }) => {
      const host = document.createElement("div");
      host.id = overlayId;
      host.style.cssText = [
        "all:initial",
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "pointer-events:none",
      ].join(";");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        .card {
          position: fixed;
          visibility: hidden;
          width: min(420px, calc(100vw - 36px));
          border: 1px solid rgba(121, 235, 216, .55);
          border-radius: 18px;
          background: rgba(8, 12, 25, .96);
          box-shadow: 0 22px 70px rgba(0, 0, 0, .44);
          color: #f7f9ff;
          padding: 18px 20px 19px;
          font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        }
        .topline { display: flex; align-items: center; gap: 10px; }
        .number {
          display: grid;
          place-items: center;
          width: 31px;
          height: 31px;
          flex: 0 0 auto;
          border-radius: 10px;
          background: linear-gradient(135deg, #70ead7, #9a8bff);
          color: #071019;
          font-size: 14px;
          font-weight: 950;
        }
        .section {
          color: #8de7da;
          font-size: 11px;
          font-weight: 850;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        h2 {
          margin: 11px 0 7px;
          color: #fff;
          font-size: 20px;
          line-height: 1.2;
          font-weight: 850;
        }
        p {
          margin: 0;
          color: #b7bfd9;
          font-size: 13px;
          line-height: 1.5;
        }
      `;
      const card = document.createElement("section");
      card.className = "card";
      card.setAttribute("role", "status");
      const topLine = document.createElement("div");
      topLine.className = "topline";
      const numberElement = document.createElement("span");
      numberElement.className = "number";
      numberElement.textContent = String(numberValue).padStart(2, "0");
      const sectionElement = document.createElement("span");
      sectionElement.className = "section";
      sectionElement.textContent = section;
      topLine.append(numberElement, sectionElement);
      const heading = document.createElement("h2");
      heading.textContent = title;
      const copy = document.createElement("p");
      copy.textContent = description;
      card.append(topLine, heading, copy);
      shadow.append(style, card);
      document.documentElement.append(host);

      const serializeRect = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        card: serializeRect(card),
        target: serializeRect(document.querySelector(`[${targetAttribute}]`)),
        badge: serializeRect(document.getElementById(badgeId)),
      };
    },
    {
      overlayId: OVERLAY_ID,
      badgeId: BADGE_ID,
      targetAttribute: TARGET_ATTRIBUTE,
      numberValue: number,
      section: step.section,
      title: step.title,
      description: step.description,
    },
  );
  const placement = chooseAnnotationPlacement(layout);
  const shownAtMs = await page.evaluate(
    async ({ overlayId, placementValue }) => {
      const card = document
        .getElementById(overlayId)
        ?.shadowRoot?.querySelector(".card");
      if (!card) return Date.now();
      card.dataset.placement = placementValue.name;
      card.style.left = `${placementValue.left}px`;
      card.style.top = `${placementValue.top}px`;
      card.style.visibility = "visible";
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return performance.timeOrigin + performance.now();
    },
    { overlayId: OVERLAY_ID, placementValue: placement },
  );
  await page.waitForTimeout(holdMs);
  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, animations: "disabled" });
  }
  return {
    target,
    selector: targetMatch?.selector || null,
    placement: placement.name,
    shownAtMs,
  };
}

export function chooseAnnotationPlacement({ viewport, card, target, badge }) {
  const right = Math.max(
    OVERLAY_MARGIN,
    viewport.width - OVERLAY_MARGIN - card.width,
  );
  const bottom = Math.max(
    OVERLAY_MARGIN,
    viewport.height - OVERLAY_MARGIN - card.height,
  );
  const badgeSafeBottom = badge
    ? Math.max(
        OVERLAY_MARGIN,
        Math.min(bottom, badge.top - BADGE_CLEARANCE - card.height),
      )
    : bottom;
  const candidates = [
    { name: "top-right", left: right, top: OVERLAY_MARGIN },
    { name: "top-left", left: OVERLAY_MARGIN, top: OVERLAY_MARGIN },
    { name: "bottom-right", left: right, top: bottom },
    { name: "bottom-left", left: OVERLAY_MARGIN, top: badgeSafeBottom },
  ];
  const paddedTarget = target
    ? {
        left: target.left - TARGET_CLEARANCE,
        top: target.top - TARGET_CLEARANCE,
        right: target.right + TARGET_CLEARANCE,
        bottom: target.bottom + TARGET_CLEARANCE,
      }
    : null;
  return candidates
    .map((candidate, preference) => {
      const rect = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + card.width,
        bottom: candidate.top + card.height,
      };
      return {
        ...candidate,
        preference,
        badgeOverlap: intersectionArea(rect, badge),
        targetOverlap: intersectionArea(rect, paddedTarget),
      };
    })
    .sort(
      (left, rightCandidate) =>
        left.badgeOverlap - rightCandidate.badgeOverlap ||
        left.targetOverlap - rightCandidate.targetOverlap ||
        left.preference - rightCandidate.preference,
    )[0];
}

function intersectionArea(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(
    0,
    Math.min(left.right, right.right) - Math.max(left.left, right.left),
  );
  const height = Math.max(
    0,
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
  );
  return width * height;
}

export async function clearAnnotatedStep(page) {
  await page.evaluate(
    ({ overlayId, targetAttribute }) => {
      document.getElementById(overlayId)?.remove();
      for (const element of document.querySelectorAll(`[${targetAttribute}]`)) {
        element.removeAttribute(targetAttribute);
      }
    },
    { overlayId: OVERLAY_ID, targetAttribute: TARGET_ATTRIBUTE },
  );
}

export async function firstVisibleTarget(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        return { locator, selector };
      }
    } catch {
      // A page may not support a candidate selector; continue to the next hook.
    }
  }
  return null;
}

export function fileSafe(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "step"
  );
}
