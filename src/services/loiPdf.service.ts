/**
 * Renders a Letter of Intent PDF from a stored Loi record, following the
 * reference template. Uses pdfkit (no headless browser).
 */
import PDFDocument from 'pdfkit';
import type { Loi } from '@prisma/client';

const BATTERY: Record<string, string> = {
  one: 'One battery',
  two: 'Two batteries',
  three_plus: 'Three or more batteries',
};
const SOLAR: Record<string, string> = { yes: 'Yes', no: 'No', planned: 'Planned' };
const TIMEFRAME: Record<string, string> = { asap: 'As soon as possible', flexible: 'Flexible' };
const REASONS: Record<string, string> = {
  backup: 'Backup power during outages',
  cost: 'Lower electricity costs',
  solar: 'Pair with existing solar',
  environmental: 'Environmental or sustainability goals',
};

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

export function generateLoiPdf(loi: Loi): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 64 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const INK = '#1a1a1a';
    const MUTED = '#555';
    const box = (on: boolean) => (on ? '[X] ' : '[  ] ');

    const h = (t: string) =>
      doc.moveDown(0.8).fillColor('#2f5d4e').font('Helvetica-Bold').fontSize(11).text(t.toUpperCase());
    const p = (t: string, opts: PDFKit.Mixins.TextOptions = {}) =>
      doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(t, { lineGap: 2, ...opts });
    const line = (label: string, value: string) =>
      doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(`${label}  ${value || '_______________________'}`, { lineGap: 3 });

    // Title
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text('LETTER OF INTENT');
    doc.fillColor(MUTED).font('Helvetica').fontSize(12).text('Battery Energy Storage Project');
    doc.moveDown(0.6);
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`LOI No. ${loi.loiNumber}`);
    doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(`Date: ${fmtDate(loi.signedAt)}`);

    doc.moveDown(0.6);
    p('This Letter of Intent ("LOI") is entered into by:');
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text('CT Battery Solutions, Inc.  ("CT Battery Solutions")');
    doc.font('Helvetica').text('and');
    doc.font('Helvetica-Bold').text(`${loi.siteOwnerName}  ("Site Owner")`);
    doc.moveDown(0.3);
    line('Property Address:', loi.propertyAddress);

    h('Purpose');
    p('The Site Owner is interested in pursuing a residential battery energy storage project at the property listed above.');
    p('CT Battery Solutions is developing battery storage projects in Connecticut and is evaluating opportunities to purchase, own, finance, install, operate, and maintain residential battery systems. CT Battery Solutions intends to serve as the Third-Party Owner (TPO) for qualifying projects, overseeing project development, financing, ownership, long-term operation of battery energy storage systems and participation in utility programs.');
    p("This Letter of Intent confirms the Site Owner's good-faith intention to work with CT Battery Solutions to evaluate and potentially move forward with a battery storage project.");

    h('Proposed Project');
    p('Estimated System:');
    doc.font('Helvetica').fontSize(10.5);
    (['one', 'two', 'three_plus'] as const).forEach((k) =>
      doc.text(box(loi.batteryCount === k) + BATTERY[k], { indent: 12 }),
    );
    doc.moveDown(0.3).text('Existing rooftop solar?');
    (['yes', 'no', 'planned'] as const).forEach((k) =>
      doc.text(box(loi.rooftopSolar === k) + SOLAR[k], { indent: 12 }),
    );
    doc.moveDown(0.3).text('Desired installation timeframe:');
    (['asap', 'flexible'] as const).forEach((k) =>
      doc.text(box(loi.timeframe === k) + TIMEFRAME[k], { indent: 12 }),
    );
    doc.moveDown(0.3).text('Primary reasons for interest:');
    Object.keys(REASONS).forEach((k) =>
      doc.text(box(loi.reasons.includes(k)) + REASONS[k], { indent: 12 }),
    );
    doc.text(box(loi.reasons.includes('other')) + 'Other: ' + (loi.reasonOther || ''), { indent: 12 });

    doc.moveDown(0.4);
    p('The project remains subject to: technical feasibility; utility interconnection approval; incentive eligibility; final pricing; financing arrangements (if applicable); and execution of a final written agreement.');

    h('Non-Binding Agreement');
    p('This Letter of Intent is non-binding and does not obligate either party to proceed with the project. Any final commitment will require a separate written agreement executed by both parties.');

    h('Use of This Letter');
    p('The Site Owner authorizes CT Battery Solutions to use this Letter of Intent as evidence of customer interest and preliminary project development in connection with: Connecticut Energy Storage Solutions Program participation; Third-Party Owner (TPO) qualification; financing and investor discussions; and other project development activities. No confidential customer information will be otherwise disclosed without the Site Owner’s permission.');

    h('Site Owner');
    line('Name:', loi.siteOwnerName);
    line('Signature:', `/s/ ${loi.signedName}`);
    line('Date:', fmtDate(loi.signedAt));
    line('Phone:', loi.phone || '');
    line('Email:', loi.email);
    doc.moveDown(0.2);
    doc.fillColor(MUTED).fontSize(8).text(
      `Electronically signed by ${loi.signedName} on ${loi.signedAt.toISOString()}${loi.signatureIp ? ` from ${loi.signatureIp}` : ''}.`,
    );

    h('CT Battery Solutions');
    line('Representative:', '');
    line('Title:', '');
    line('Signature:', '');
    line('Date:', '');

    doc.end();
  });
}
