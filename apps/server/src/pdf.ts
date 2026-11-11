/**
 * Builds the resume and cover letter PDFs with pdfkit (pure JavaScript, no
 * browser needed). Pages are A4 and use the built-in Helvetica fonts.
 *
 * The resume's text comes from the profile itself, chosen by the tailored
 * resume's ids, so the PDF can only contain what the user wrote or approved.
 *
 * Limitation: the built-in fonts cover Western European characters only.
 * Other scripts would need an embedded font.
 */
import PDFDocument from "pdfkit";
import type { CoverLetter, Profile, TailoredResume } from "@draftline/shared";

const MARGIN = 50;
const MUTED = "#555555";

/** Collects pdfkit's output stream into one buffer. */
function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function newDocument(title: string, author: string): PDFKit.PDFDocument {
  return new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: { Title: title, Author: author },
  });
}

/** Name in large type, then location, email, phone and links on one line. */
function writeHeader(doc: PDFKit.PDFDocument, profile: Profile): void {
  const { contact } = profile;
  doc.font("Helvetica-Bold").fontSize(20).fillColor("black").text(contact.fullName || " ");
  const details = [
    contact.location,
    contact.email,
    contact.phone,
    ...contact.links.map((link) => link.url),
  ].filter(Boolean);
  if (details.length > 0) {
    doc.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor(MUTED).text(details.join("  ·  "));
  }
  doc.fillColor("black");
}

function writeSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.9).font("Helvetica-Bold").fontSize(11).fillColor("black").text(title.toUpperCase());
  const y = doc.y + 2;
  doc
    .moveTo(MARGIN, y)
    .lineTo(doc.page.width - MARGIN, y)
    .lineWidth(0.5)
    .strokeColor("#999999")
    .stroke();
  doc.moveDown(0.4);
}

const dateRange = (start: string, end: string) =>
  [start, end].filter(Boolean).join(" – ");

export async function renderResume(
  profile: Profile,
  spec: TailoredResume,
): Promise<Buffer> {
  const doc = newDocument(`${profile.contact.fullName} resume`, profile.contact.fullName);
  writeHeader(doc, profile);

  if (spec.summary) {
    writeSectionTitle(doc, "Summary");
    doc.font("Helvetica").fontSize(10).text(spec.summary, { lineGap: 1.5 });
  }

  const roles = spec.roles.flatMap(({ roleId, bulletIds }) => {
    const role = profile.experience.find((r) => r.id === roleId);
    return role ? [{ role, bulletIds }] : [];
  });
  if (roles.length > 0) {
    writeSectionTitle(doc, "Experience");
    roles.forEach(({ role, bulletIds }, index) => {
      if (index > 0) doc.moveDown(0.6);
      doc
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .text([role.title, role.company].filter(Boolean).join(", "));
      const meta = [role.location, dateRange(role.startDate, role.endDate)].filter(Boolean);
      if (meta.length > 0) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(meta.join("  ·  ")).fillColor("black");
      }
      const bullets = bulletIds.flatMap((id) => {
        const bullet = role.bullets.find((b) => b.id === id);
        return bullet?.text.trim() ? [bullet.text.trim()] : [];
      });
      if (bullets.length > 0) {
        doc.moveDown(0.2).font("Helvetica").fontSize(10);
        doc.list(bullets, { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 });
      }
    });
  }

  const projects = spec.projectIds.flatMap((id) => {
    const project = profile.projects.find((p) => p.id === id);
    return project ? [project] : [];
  });
  if (projects.length > 0) {
    writeSectionTitle(doc, "Projects");
    projects.forEach((project, index) => {
      if (index > 0) doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(10.5).text(project.name);
      if (project.description) doc.font("Helvetica").fontSize(10).text(project.description, { lineGap: 1.5 });
      if (project.url) doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(project.url).fillColor("black");
    });
  }

  if (profile.education.length > 0) {
    writeSectionTitle(doc, "Education");
    profile.education.forEach((school, index) => {
      if (index > 0) doc.moveDown(0.4);
      const degree = [school.degree, school.field].filter(Boolean).join(", ");
      doc.font("Helvetica-Bold").fontSize(10.5).text([degree, school.school].filter(Boolean).join(" — "));
      const dates = dateRange(school.startDate, school.endDate);
      if (dates) doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(dates).fillColor("black");
      if (school.details) doc.font("Helvetica").fontSize(10).text(school.details, { lineGap: 1.5 });
    });
  }

  if (profile.certifications.length > 0) {
    writeSectionTitle(doc, "Certifications");
    doc.font("Helvetica").fontSize(10);
    doc.list(
      profile.certifications.map((c) => [c.name, c.issuer, c.date].filter(Boolean).join(", ")),
      { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 },
    );
  }

  if (spec.skills.length > 0) {
    writeSectionTitle(doc, "Skills");
    doc.font("Helvetica").fontSize(10).text(spec.skills.join(", "), { lineGap: 1.5 });
  }

  return toBuffer(doc);
}

export async function renderCoverLetter(
  profile: Profile,
  company: string,
  letter: CoverLetter,
  date = new Date(),
): Promise<Buffer> {
  const name = profile.contact.fullName;
  const doc = newDocument(`${name} cover letter`, name);
  writeHeader(doc, profile);

  doc
    .moveDown(1.5)
    .font("Helvetica")
    .fontSize(10.5)
    .text(date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }));
  doc.moveDown(1).text(company ? `Dear Hiring Team at ${company},` : "Dear Hiring Team,");

  for (const paragraph of letter.body.split(/\n\s*\n/)) {
    if (!paragraph.trim()) continue;
    doc.moveDown(0.8).text(paragraph.trim().replace(/\s*\n\s*/g, " "), { lineGap: 2, align: "left" });
  }

  doc.moveDown(1.2).text("Sincerely,").moveDown(0.3).text(name);
  return toBuffer(doc);
}

/** A file name like "Ada Lovelace - Resume - Acme.pdf", safe on any system. */
export function documentFileName(name: string, kind: "Resume" | "Cover letter", company: string): string {
  const safe = (text: string) =>
    text.replace(/[^\p{L}\p{N} .,&'-]+/gu, " ").replace(/\s+/g, " ").trim();
  return `${[safe(name) || "Draftline", kind, safe(company)].filter(Boolean).join(" - ")}.pdf`;
}
