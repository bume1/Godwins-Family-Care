/**
 * PDF Generator for Service Reports and Validation Reports
 * Uses pdfkit to generate professional PDF documents
 */

const path = require('path');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib, StandardFonts, rgb } = require('pdf-lib');
const consentText = require('./public/consent-text');   // approved consent bodies, versioned (Session 4.6)
const insuranceEligibility = require('./insuranceEligibility'); // B1: one payer vocabulary
const consentRender = require('./consentRender');       // client-record values a body renders (4.6)
const gfcTime = require('./public/gfc-time');           // the single source of the clock — Eastern, both sides
// Fax formatting comes from the order module rather than a second copy here: a
// requisition printing a number in a different shape from the screen that sent
// it is how two records of one disclosure start disagreeing.
const { formatFax: reqFmtFax } = require('./orderRequisitions');

/**
 * Fetch a URL with a timeout so hung external requests (e.g. dead Google Drive
 * links or old photo storage URLs) never block PDF generation indefinitely.
 */
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Color constants
const COLORS = {
  primary: '#045E9F',
  accent: '#00205A',
  gray: '#666666',
  lightGray: '#999999',
  darkGray: '#333333',
  black: '#000000',
  tableBg: '#f5f5f5',
  headerBg: '#e0e0e0'
};

/**
 * Fetch a photo from a URL and return as a Buffer
 * Works with Google Drive URLs and other public URLs
 */
async function fetchPhotoBuffer(photo) {
  // Determine the best URL to fetch from
  let url = null;
  if (photo.driveFileId) {
    // Use Google Drive direct export URL for reliable image fetching
    url = `https://drive.google.com/uc?id=${photo.driveFileId}&export=download`;
  } else if (photo.webContentLink) {
    url = photo.webContentLink;
  } else if (photo.url && (photo.url.startsWith('http://') || photo.url.startsWith('https://'))) {
    url = photo.url;
  }

  if (!url) return null;

  try {
    const response = await fetchWithTimeout(url, 8000);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error(`Failed to fetch photo ${photo.name || photo.id}: ${e.message}`);
    return null;
  }
}

/**
 * Pre-fetch all photo buffers for a report (concurrent for speed)
 */
async function fetchReportPhotos(photos) {
  if (!photos || photos.length === 0) return [];

  const settled = await Promise.all(
    photos.map(async (photo) => {
      const buffer = await fetchPhotoBuffer(photo);
      return buffer && buffer.length > 0 ? { ...photo, buffer } : null;
    })
  );
  return settled.filter(Boolean);
}

/**
 * Generate a Service Report PDF
 * @param {Object} reportData - The service report data
 * @param {string} technicianName - Name of the technician who created the report
 * @returns {Promise<Buffer>} PDF as a Buffer
 */
async function generateServiceReportPDF(reportData, technicianName) {
  // Pre-fetch all photo images before generating the PDF
  const photoBuffers = await fetchReportPhotos(reportData.photos);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margin: 50,
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const reportDate = new Date(reportData.serviceCompletionDate || reportData.createdAt || Date.now()).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Header
      doc.fontSize(14).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text('THRIVE 365 LABS', 50, 30);
      doc.text('SERVICE REPORT', 400, 30, { align: 'right' });

      doc.moveTo(50, 55).lineTo(562, 55).strokeColor(COLORS.primary).lineWidth(2).stroke();

      // Report ID
      doc.fontSize(9).fillColor(COLORS.gray).font('Helvetica');
      doc.text(`Report ID: ${reportData.id || 'N/A'}`, 50, 65);

      // CLIENT INFORMATION Section
      let y = 95;
      doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
      doc.text('CLIENT INFORMATION', 50, y);
      doc.moveTo(50, y + 15).lineTo(200, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
      y += 25;

      // Client info table
      const clientFields = [
        ['Client/Facility', reportData.clientFacilityName || '-', 'Service Date', reportDate],
        ['Customer Name', reportData.customerName || '-', 'Ticket #', reportData.hubspotTicketNumber || '-'],
        ['Address', reportData.address || '-'],
        ['Analyzer Model', reportData.analyzerModel || '-', 'Serial Number', reportData.analyzerSerialNumber || '-'],
        ['Service Provider', reportData.serviceProviderName || technicianName || '-']
      ];

      y = drawFieldTable(doc, clientFields, 50, y);

      // SERVICE PERFORMED Section
      y += 20;
      doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
      doc.text('SERVICE PERFORMED', 50, y);
      doc.moveTo(50, y + 15).lineTo(200, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
      y += 25;

      // Service type
      drawFieldRow(doc, 'Service Type', reportData.serviceType || '-', 50, y);
      y += 20;

      // Conditional content based on service type
      if (reportData.serviceType === 'Validations') {
        // ON-SITE SERVICE DETAILS section
        if (y > 550) { doc.addPage(); y = 50; }
        y += 10;
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('ON-SITE SERVICE DETAILS', 50, y);
        doc.moveTo(50, y + 15).lineTo(235, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 25;

        drawFieldRow(doc, 'Validation Start Date', reportData.validationStartDate || '-', 50, y, 'Validation End Date', reportData.validationEndDate || '-');
        y += 20;
        drawFieldRow(doc, 'Analyzer Serial Number', reportData.analyzerSerialNumber || '-', 50, y);
        y += 20;
        const materialsVal = reportData.materialsAvailable !== undefined && reportData.materialsAvailable !== null
          ? (reportData.materialsAvailable === true || reportData.materialsAvailable === 'Yes' ? 'Yes' : 'No')
          : '-';
        drawFieldRow(doc, 'Materials Available', materialsVal, 50, y);
        y += 20;

        // Helper to render a single day segment with all fields
        const renderValidationDay = (seg, dayLabel) => {
          if (y > 640) { doc.addPage(); y = 50; }

          const segDate = seg.date ? new Date(seg.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';

          // Day header with colored bar
          doc.rect(50, y, 512, 18).fillColor('#EBF5FF').fill();
          doc.fontSize(9).fillColor(COLORS.accent).font('Helvetica-Bold');
          doc.text(dayLabel, 55, y + 4);
          doc.fontSize(9).fillColor(COLORS.gray).font('Helvetica');
          doc.text(segDate, 55 + (dayLabel.length * 5.5) + 8, y + 4);
          const statusText = seg.status === 'complete' ? 'Complete' : 'In Progress';
          doc.text(statusText, 450, y + 4, { width: 100, align: 'right' });
          y += 22;

          if (seg.testsPerformed) {
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica-Bold');
            doc.text('Tests Performed:', 55, y);
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica');
            const h = doc.heightOfString(seg.testsPerformed, { width: 420 });
            doc.text(seg.testsPerformed, 155, y, { width: 420 });
            y += Math.max(12, h + 2);
          }

          if (seg.results) {
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica-Bold');
            doc.text('Results/Readings:', 55, y);
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica');
            const h = doc.heightOfString(seg.results, { width: 420 });
            doc.text(seg.results, 155, y, { width: 420 });
            y += Math.max(12, h + 2);
          }

          // Training Completed (per-day toggle)
          const trainingDone = seg.trainingCompleted === true || seg.trainingCompleted === 'Yes';
          doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica-Bold');
          doc.text('Training Completed:', 55, y);
          doc.fontSize(8).fillColor(trainingDone ? COLORS.primary : COLORS.darkGray).font('Helvetica');
          doc.text(trainingDone ? 'Yes' : 'No', 155, y);
          y += 12;

          if (!trainingDone && seg.trainingReason) {
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica-Bold');
            doc.text('Reason:', 65, y);
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica');
            const h = doc.heightOfString(seg.trainingReason, { width: 410 });
            doc.text(seg.trainingReason, 115, y, { width: 410 });
            y += Math.max(12, h + 2);
          }

          // Outstanding Issues/Items (renamed from observations)
          const issues = seg.outstandingIssues || seg.observations;
          if (issues) {
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica-Bold');
            doc.text('Outstanding Issues/Items:', 55, y);
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica');
            const h = doc.heightOfString(issues, { width: 360 });
            doc.text(issues, 200, y, { width: 360 });
            y += Math.max(12, h + 2);
          }

          if (seg.finalRecommendations) {
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica-Bold');
            doc.text('Final Recommendations:', 55, y);
            doc.fontSize(8).fillColor(COLORS.darkGray).font('Helvetica');
            const h = doc.heightOfString(seg.finalRecommendations, { width: 360 });
            doc.text(seg.finalRecommendations, 200, y, { width: 360 });
            y += Math.max(12, h + 2);
          }

          y += 8; // spacing between days
        };

        // Day-by-day validation breakdown split by phase
        if (Array.isArray(reportData.validationSegments) && reportData.validationSegments.length > 0) {
          const onsiteSegs = reportData.validationSegments.filter(s => !s.phase || s.phase === 'onsite');
          const offsiteSegs = reportData.validationSegments.filter(s => s.phase === 'offsite');

          // ON-SITE DAILY VALIDATION LOG
          if (onsiteSegs.length > 0) {
            if (y > 550) { doc.addPage(); y = 50; }
            y += 10;
            doc.fontSize(10).fillColor(COLORS.accent).font('Helvetica-Bold');
            doc.text('ON-SITE DAILY VALIDATION LOG', 50, y);
            doc.moveTo(50, y + 14).lineTo(290, y + 14).strokeColor(COLORS.accent).lineWidth(1).stroke();
            y += 25;

            onsiteSegs.forEach((seg, idx) => {
              renderValidationDay(seg, `On-Site Day ${seg.day || (idx + 1)}`);
            });
            y += 5;
          }

          // OFF-SITE CONTINUED VALIDATION LOG
          if (offsiteSegs.length > 0) {
            if (y > 550) { doc.addPage(); y = 50; }
            y += 10;
            doc.fontSize(10).fillColor(COLORS.accent).font('Helvetica-Bold');
            doc.text('OFF-SITE CONTINUED VALIDATION LOG', 50, y);
            doc.moveTo(50, y + 14).lineTo(330, y + 14).strokeColor(COLORS.accent).lineWidth(1).stroke();
            y += 25;

            offsiteSegs.forEach((seg, idx) => {
              renderValidationDay(seg, `Off-Site Day ${seg.day || (idx + 1)}`);
            });
            y += 5;
          }
        }

        if (reportData.trainingProvided) {
          drawFieldRow(doc, 'Training Provided', reportData.trainingProvided, 50, y);
          y += 20 + Math.ceil(reportData.trainingProvided.length / 80) * 12;
        }

        if (reportData.validationResults) {
          drawFieldRow(doc, 'Validation Results', reportData.validationResults, 50, y);
          y += 20 + Math.ceil(reportData.validationResults.length / 80) * 12;
        }

        if (reportData.recommendations) {
          drawFieldRow(doc, 'Recommendations', reportData.recommendations, 50, y);
          y += 20 + Math.ceil(reportData.recommendations.length / 80) * 12;
        }

        // VALIDATION REPORT DOCUMENT reference
        if (reportData.validationReportDocumentName || reportData.validationReportDocumentUrl) {
          if (y > 650) { doc.addPage(); y = 50; }
          y += 15;
          doc.fontSize(10).fillColor(COLORS.accent).font('Helvetica-Bold');
          doc.text('VALIDATION REPORT DOCUMENT', 50, y);
          doc.moveTo(50, y + 14).lineTo(280, y + 14).strokeColor(COLORS.accent).lineWidth(1).stroke();
          y += 25;
          const docName = reportData.validationReportDocumentName || 'Validation Report';
          doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
          doc.text('Document:', 55, y);
          doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica');
          doc.text(docName, 120, y, { width: 440 });
          y += 16;
          if (reportData.validationReportDocumentUrl) {
            doc.fontSize(8).fillColor(COLORS.gray).font('Helvetica');
            doc.text('See attached document or client portal for download link.', 55, y, { width: 500 });
            y += 14;
          }
        }
      } else {
        // Regular service fields
        if (reportData.descriptionOfWork) {
          drawFieldRow(doc, 'Description of Work', reportData.descriptionOfWork, 50, y);
          y += 20 + Math.ceil(reportData.descriptionOfWork.length / 80) * 12;
        }

        if (reportData.materialsUsed) {
          drawFieldRow(doc, 'Materials Used', reportData.materialsUsed, 50, y);
          y += 20 + Math.ceil(reportData.materialsUsed.length / 80) * 12;
        }

        if (reportData.solution) {
          drawFieldRow(doc, 'Solution', reportData.solution, 50, y);
          y += 20 + Math.ceil(reportData.solution.length / 80) * 12;
        }

        if (reportData.outstandingIssues) {
          drawFieldRow(doc, 'Final Recommendations', reportData.outstandingIssues, 50, y);
          y += 20 + Math.ceil(reportData.outstandingIssues.length / 80) * 12;
        }
      }

      // REFERENCE PHOTOS Section (if any photos were fetched)
      if (photoBuffers && photoBuffers.length > 0) {
        doc.addPage();
        y = 50;
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('REFERENCE PHOTOS', 50, y);
        doc.moveTo(50, y + 15).lineTo(210, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 30;

        const photoWidth = 240;
        const photoHeight = 180;
        const gap = 20;

        for (let i = 0; i < photoBuffers.length; i++) {
          const pb = photoBuffers[i];
          const col = i % 2;
          const x = 50 + col * (photoWidth + gap);

          // New row: check if we need a new page
          if (col === 0 && i > 0) {
            y += photoHeight + 30;
          }
          if (y + photoHeight + 20 > 720) {
            doc.addPage();
            y = 50;
          }

          try {
            doc.image(pb.buffer, x, y, { fit: [photoWidth, photoHeight], align: 'center', valign: 'center' });
            doc.rect(x, y, photoWidth, photoHeight).strokeColor(COLORS.gray).lineWidth(0.5).stroke();
          } catch (imgErr) {
            doc.rect(x, y, photoWidth, photoHeight).strokeColor(COLORS.gray).lineWidth(0.5).stroke();
            doc.fontSize(9).fillColor(COLORS.lightGray).font('Helvetica-Oblique');
            doc.text('(Image could not be rendered)', x + 50, y + photoHeight / 2 - 5);
          }
          // Caption
          doc.fontSize(8).fillColor(COLORS.gray).font('Helvetica');
          doc.text(pb.name || `Photo ${i + 1}`, x, y + photoHeight + 3, { width: photoWidth, align: 'center' });
        }
        // Advance y past the last row
        y += photoHeight + 30;
      }

      // Check if we need a new page for signatures
      if (y > 600) {
        doc.addPage();
        y = 50;
      }

      // SIGNATURES Section
      y += 20;
      doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
      doc.text('SIGNATURES', 50, y);
      doc.moveTo(50, y + 15).lineTo(150, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
      y += 30;

      // Customer signature
      doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
      doc.text('Customer Signature:', 50, y);
      doc.rect(50, y + 15, 200, 50).strokeColor(COLORS.gray).stroke();

      if (reportData.customerSignature && reportData.customerSignature.startsWith('data:image')) {
        try {
          doc.image(reportData.customerSignature, 55, y + 20, { width: 190, height: 40 });
        } catch (e) {
          doc.fontSize(10).fillColor(COLORS.lightGray).font('Helvetica-Oblique');
          doc.text('(Signature image unavailable)', 70, y + 35);
        }
      } else {
        doc.fontSize(10).fillColor(COLORS.lightGray).font('Helvetica-Oblique');
        doc.text('(Not signed)', 120, y + 35);
      }
      // Customer name
      const customerName = [reportData.customerFirstName, reportData.customerLastName].filter(Boolean).join(' ');
      if (customerName) {
        doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica');
        doc.text(customerName, 50, y + 68);
        doc.fontSize(8).fillColor(COLORS.gray).font('Helvetica');
        doc.text(`Date: ${reportData.customerSignatureDate || '-'}`, 50, y + 82);
      } else {
        doc.fontSize(8).fillColor(COLORS.gray).font('Helvetica');
        doc.text(`Date: ${reportData.customerSignatureDate || '-'}`, 50, y + 70);
      }

      // Technician signature
      doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
      doc.text('Technician Signature:', 300, y);
      doc.rect(300, y + 15, 200, 50).strokeColor(COLORS.gray).stroke();

      if (reportData.technicianSignature && reportData.technicianSignature.startsWith('data:image')) {
        try {
          doc.image(reportData.technicianSignature, 305, y + 20, { width: 190, height: 40 });
        } catch (e) {
          doc.fontSize(10).fillColor(COLORS.lightGray).font('Helvetica-Oblique');
          doc.text('(Signature image unavailable)', 320, y + 35);
        }
      } else {
        doc.fontSize(10).fillColor(COLORS.lightGray).font('Helvetica-Oblique');
        doc.text('(Not signed)', 370, y + 35);
      }
      // Technician name
      const techName = [reportData.technicianFirstName, reportData.technicianLastName].filter(Boolean).join(' ');
      if (techName) {
        doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica');
        doc.text(techName, 300, y + 68);
        doc.fontSize(8).fillColor(COLORS.gray).font('Helvetica');
        doc.text(`Date: ${reportData.technicianSignatureDate || '-'}`, 300, y + 82);
      } else {
        doc.fontSize(8).fillColor(COLORS.gray).font('Helvetica');
        doc.text(`Date: ${reportData.technicianSignatureDate || '-'}`, 300, y + 70);
      }

      // Footer
      doc.fontSize(8).fillColor(COLORS.lightGray).font('Helvetica-Oblique');
      doc.text(`Generated on ${new Date().toLocaleString()}`, 50, 720, { align: 'center', width: 512 });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Draw a field row with label and value
 */
function drawFieldRow(doc, label1, value1, x, y, label2 = null, value2 = null) {
  doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
  doc.text(label1 + ':', x, y);
  doc.fontSize(10).fillColor(COLORS.black).font('Helvetica');
  doc.text(value1, x + 120, y, { width: label2 ? 130 : 380 });

  if (label2) {
    doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
    doc.text(label2 + ':', 300, y);
    doc.fontSize(10).fillColor(COLORS.black).font('Helvetica');
    doc.text(value2, 420, y, { width: 130 });
  }
}

/**
 * Draw a table of client info fields
 */
function drawFieldTable(doc, rows, x, startY) {
  let y = startY;

  rows.forEach(row => {
    if (row.length === 4) {
      drawFieldRow(doc, row[0], row[1], x, y, row[2], row[3]);
      // Calculate row height based on longest value text in the row
      const val1Width = 130;
      const val2Width = 130;
      const val1Height = doc.fontSize(10).font('Helvetica').heightOfString(row[1] || '-', { width: val1Width });
      const val2Height = doc.fontSize(10).font('Helvetica').heightOfString(row[3] || '-', { width: val2Width });
      y += Math.max(18, Math.max(val1Height, val2Height) + 4);
    } else if (row.length === 2) {
      drawFieldRow(doc, row[0], row[1], x, y);
      const valHeight = doc.fontSize(10).font('Helvetica').heightOfString(row[1] || '-', { width: 380 });
      y += Math.max(18, valHeight + 4);
    }
  });

  return y;
}

/**
 * Fetch a PDF buffer from a URL (Google Drive or other)
 */
async function fetchAttachmentBuffer(url) {
  if (!url) return null;
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error(`Failed to fetch attachment from ${url}: ${e.message}`);
    return null;
  }
}

/**
 * Merge multiple PDF buffers into a single PDF buffer using pdf-lib.
 * Non-PDF or unreadable buffers are silently skipped.
 */
async function mergePDFBuffers(pdfBuffers) {
  const merged = await PDFLib.create();
  for (const buf of pdfBuffers) {
    if (!buf || buf.length === 0) continue;
    try {
      const doc = await PDFLib.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    } catch (e) {
      console.error('Skipping unreadable PDF during merge:', e.message);
    }
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

/**
 * Generate a service/validation report PDF and append any uploaded PDF attachments.
 * Returns a single merged PDF buffer.
 *
 * Attachment sources checked (in order):
 *  1. report.validationReportDocument  – uploaded validation document (final submission)
 *  2. report.clientFiles[]             – PDF files uploaded by admins/managers
 */
async function generateServiceReportWithAttachments(reportData, technicianName) {
  const reportBuffer = await generateServiceReportPDF(reportData, technicianName);

  const attachmentBuffers = [];

  // Helper: resolve a Drive file object to a download URL
  const driveUrl = (fileObj) => {
    if (!fileObj) return null;
    if (fileObj.driveFileId) return `https://drive.google.com/uc?id=${fileObj.driveFileId}&export=download`;
    if (fileObj.driveWebContentLink) return fileObj.driveWebContentLink;
    if (fileObj.webContentLink) return fileObj.webContentLink;
    return null;
  };

  // 1. Validation report document (uploaded when submitting validation)
  const vrd = reportData.validationReportDocument;
  if (vrd) {
    const url = driveUrl(vrd);
    if (url) {
      console.log(`📎 Fetching validation document for merge: ${vrd.filename || url}`);
      const buf = await fetchAttachmentBuffer(url);
      if (buf) {
        attachmentBuffers.push(buf);
        console.log(`✅ Validation document fetched (${buf.length} bytes)`);
      } else {
        console.warn(`⚠️  Could not fetch validation document from ${url}`);
      }
    }
  }

  // 2. Client files (PDF only) uploaded by admins/managers
  const clientFiles = Array.isArray(reportData.clientFiles) ? reportData.clientFiles : [];
  for (const file of clientFiles) {
    const isPDF = (file.mimeType || '').toLowerCase().includes('pdf') ||
                  (file.name || '').toLowerCase().endsWith('.pdf');
    if (!isPDF) continue;
    if (file.driveStatus === 'failed' || file.driveStatus === 'pending') continue;

    const url = driveUrl(file);
    if (!url) continue;

    console.log(`📎 Fetching client file for merge: ${file.name || url}`);
    const buf = await fetchAttachmentBuffer(url);
    if (buf) {
      attachmentBuffers.push(buf);
      console.log(`✅ Client file fetched (${buf.length} bytes): ${file.name}`);
    } else {
      console.warn(`⚠️  Could not fetch client file from ${url}`);
    }
  }

  if (attachmentBuffers.length === 0) {
    // Nothing to merge, return the original report
    return reportBuffer;
  }

  console.log(`📄 Merging service report with ${attachmentBuffers.length} attachment(s)`);
  return mergePDFBuffers([reportBuffer, ...attachmentBuffers]);
}

// GFC brand colors for the enrollment packet.
const GFC_COLORS = { navy: '#033D50', gold: '#C9A44A', ink: '#1B2A33', muted: '#4F6470', line: '#E1D9C9' };

// Human-readable consent labels. Sourced from public/consent-text.js so the
// packet can never disagree with the registry (this was a second hand-kept map
// until Session 4.6). `roiTransfer` is the Transfer-of-Care ROI, which is its
// own document rather than a registry entry.
const GFC_CONSENT_LABELS = consentText.types().reduce((acc, t) => {
  acc[t] = consentText.titleFor(t);
  return acc;
}, { roiTransfer: 'Transfer-of-Care Authorization (record release)' });

/**
 * Generate the client's Enrollment Packet PDF — an in-portal copy of the Stage 2
 * intake summary plus every signed consent with its e-signature metadata
 * (typed name + server timestamp). This is the portal-delivered record; per the
 * compliance decision, the full packet is NEVER emailed — it lives in the
 * Documents tab only.
 *
 * NOTE: consent language is a working draft pending counsel/licensure review.
 * TEST DATA ONLY until HIPAA-live.
 *
 * @param {Object} client - the client user record (intake, consents, consentMeta)
 * @returns {Promise<Buffer>}
 */
async function generateEnrollmentPacketPDF(client, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const intake = client.intake || {};
      const consents = client.consents || {};
      const meta = client.consentMeta || {};
      const name = client.preferredName || client.name || 'Client';

      // Header
      doc.fontSize(18).fillColor(GFC_COLORS.navy).font('Helvetica-Bold');
      doc.text('Godwins Family Care', 50, 40);
      doc.fontSize(12).fillColor(GFC_COLORS.gold).text('Enrollment Packet', 50, 64);
      doc.moveTo(50, 84).lineTo(562, 84).strokeColor(GFC_COLORS.gold).lineWidth(2).stroke();

      doc.fontSize(9).fillColor(GFC_COLORS.muted).font('Helvetica');
      doc.text(`Generated ${new Date().toLocaleString('en-US')}`, 50, 92, { align: 'right', width: 512 });
      // No review or test-data banner on any copy, staff copies included
      // (owner, 2026-10-28): staff copies get faxed and handed to providers.
      // The review status lives on the admin screen, never on a document.

      let y = 120;
      const heading = (t) => {
        if (y > 690) { doc.addPage(); y = 50; }
        doc.fontSize(12).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text(t, 50, y);
        doc.moveTo(50, y + 16).lineTo(200, y + 16).strokeColor(GFC_COLORS.line).lineWidth(1).stroke();
        y += 26;
      };
      const row = (label, value) => {
        if (y > 720) { doc.addPage(); y = 50; }
        doc.fontSize(9).fillColor(GFC_COLORS.muted).font('Helvetica-Bold').text(label, 50, y, { width: 160 });
        doc.fontSize(9).fillColor(GFC_COLORS.ink).font('Helvetica').text(value || '—', 215, y, { width: 347 });
        y += 18;
      };

      // Client summary
      heading('Client');
      row('Name', name);
      row('Date of birth', intake.dob ? `${intake.dob}${intake.age != null ? `  (age ${intake.age})` : ''}` : '—');
      row('Service line', client.serviceLine || '—');
      if (intake.primaryContact) row('Primary contact', `${intake.primaryContact.name || '—'}${intake.primaryContact.relationship ? ` (${intake.primaryContact.relationship})` : ''}`);
      if (intake.payerType) row('Payer', intake.payerType);

      // Medications (structured rows)
      const meds = Array.isArray(intake.medications) ? intake.medications.filter(m => m && m.name) : [];
      if (meds.length) {
        y += 6; heading('Medications');
        meds.forEach(m => {
          const parts = [m.dose, m.route, m.frequency].filter(Boolean).join(' · ');
          row(m.name, [parts, m.prescriber ? `Rx: ${m.prescriber}` : '', m.pharmacy ? `Pharmacy: ${m.pharmacy}` : ''].filter(Boolean).join('   '));
        });
      }

      // Signed consents
      y += 6; heading('Signed Consents');
      const listedKeys = Object.keys(consents).filter(k => consents[k] && consents[k] !== 'pending');
      if (!listedKeys.length) {
        row('—', 'No consents on file.');
      } else {
        listedKeys.forEach(k => {
          if (y > 720) { doc.addPage(); y = 50; }
          const m = meta[k] || {};
          const status = consents[k];
          doc.fontSize(10).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text(GFC_CONSENT_LABELS[k] || k, 50, y, { width: 512 });
          y += 15;
          // Every executed consent carries a signer, a timestamp and a hashed
          // client IP. Scope E1 found one recorded as "Signed" with neither,
          // because an inactive opt-in was being written as a signature; the
          // status vocabulary now keeps the two apart, and this line reports
          // whichever it actually is rather than calling both "Signed".
          let detail;
          if (status === 'na') detail = 'Declined / not applicable — opt-out recorded' + (m.recordedAt ? ` on ${new Date(m.recordedAt).toLocaleString('en-US')}` : '');
          else if (status === 'optin_recorded') detail = 'Preference recorded — this option is not live, so nothing was signed' + (m.recordedAt ? ` (${new Date(m.recordedAt).toLocaleString('en-US')})` : '');
          else if (status === 'signed_offline') detail = `Signed on paper${m.signedAt ? ` on ${new Date(m.signedAt).toLocaleDateString('en-US')}` : ''} · recorded by staff`;
          else detail = `Signed by ${m.signedAs || m.typedName || name}${m.signedAt ? ` on ${new Date(m.signedAt).toLocaleString('en-US')}` : ''}${m.ipHash ? `  ·  verification ${String(m.ipHash).slice(0, 12)}` : ''}`;
          doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica').text(detail, 50, y, { width: 512 });
          y += 12;
          if (m.version) {
            doc.fontSize(7.5).fillColor(GFC_COLORS.muted).font('Helvetica').text(`Document version ${m.version}`, 50, y, { width: 512 });
            y += 11;
          }
          y += 8;
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================
// Executed-consent PDF (Session 4.6, Scope C)
//
// Before this existed, `pdf-generator.js` produced an enrollment summary, the
// provider ROI and the care plan — and nothing for any of the fourteen
// consents. A client could not be handed a copy of what they signed. For the
// Notice of Privacy Practices that is a regulatory problem (45 CFR 164.520
// entitles the individual to a paper copy on request), not a nicety.
//
// The body is rendered AT THE VERSION STORED ON THE CONSENT RECORD, so a copy
// reproduces what the client actually saw. Editing the current text later never
// rewrites an old signature's document.
// ============================================================

// Split a body line on **bold** runs so the emphasis in the approved wording
// survives into the PDF instead of printing literal asterisks.
function renderRichText(doc, text, x, width, opts = {}) {
  const size = opts.size || 9.5;
  const color = opts.color || GFC_COLORS.ink;
  const parts = String(text == null ? '' : text).split(/(\*\*[^*]+\*\*)/g).filter(t => t !== '');
  doc.fontSize(size).fillColor(color);
  parts.forEach((part, i) => {
    const bold = /^\*\*[^*]+\*\*$/.test(part);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(bold ? part.slice(2, -2) : part, i === 0 ? x : undefined, i === 0 ? doc.y : undefined, {
      width, continued: i < parts.length - 1, lineGap: opts.lineGap == null ? 1.5 : opts.lineGap
    });
  });
  doc.font('Helvetica');
}

/**
 * Render one consent body (block list) into an open pdfkit document.
 * Shared by the single-consent PDF and any caller that wants the body inline.
 */
function renderConsentBody(doc, blocks, renderData, geom) {
  const { left, width } = geom;
  const space = (n) => { doc.y += n; };
  const pageBreakIfNeeded = (need) => {
    if (doc.y + (need || 60) > doc.page.height - doc.page.margins.bottom) doc.addPage();
  };

  blocks.forEach(b => {
    pageBreakIfNeeded(48);
    if (b.t === 'h') {
      space(8);
      doc.fontSize(11).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text(b.text, left, doc.y, { width });
      space(3);
    } else if (b.t === 'sub') {
      space(6);
      doc.fontSize(9.5).fillColor(GFC_COLORS.navy).font('Helvetica-Oblique').text(b.text, left, doc.y, { width });
      doc.font('Helvetica');
      space(2);
    } else if (b.t === 'p') {
      doc.x = left;
      renderRichText(doc, b.text, left, width);
      space(5);
    } else if (b.t === 'ul') {
      (b.items || []).forEach(item => {
        pageBreakIfNeeded(30);
        doc.fontSize(9.5).fillColor(GFC_COLORS.gold).font('Helvetica-Bold').text('•', left, doc.y, { width: 10, continued: false });
        const bulletY = doc.y - doc.currentLineHeight();
        doc.y = bulletY;
        doc.x = left + 12;
        renderRichText(doc, item, left + 12, width - 12);
        space(2);
      });
      space(4);
    } else if (b.t === 'note') {
      space(4);
      doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica-Oblique').text(b.text, left, doc.y, { width });
      doc.font('Helvetica');
      space(5);
    } else if (b.t === 'choice') {
      // The election as recorded. A blank box on a signed copy would be worse
      // than useless — it is the one part of the page a reader checks.
      pageBreakIfNeeded(50);
      space(4);
      doc.fontSize(9).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text(b.label, left, doc.y, { width });
      space(2);
      const chosen = (renderData && renderData.__choices && renderData.__choices[b.key]) || null;
      (b.options || []).forEach(o => {
        const on = chosen === o.value;
        doc.fontSize(9).fillColor(on ? GFC_COLORS.ink : GFC_COLORS.muted).font(on ? 'Helvetica-Bold' : 'Helvetica')
          .text((on ? '[X]  ' : '[  ]  ') + o.label, left + 10, doc.y, { width: width - 10 });
        space(1);
      });
      if (!chosen) {
        doc.fontSize(8).fillColor(GFC_COLORS.muted).font('Helvetica-Oblique').text('No election recorded.', left + 10, doc.y, { width: width - 10 });
        doc.font('Helvetica');
      }
      space(6);
    } else if (b.t === 'data') {
      // Values RENDERED from the client record — the one-pass rule (Scope G4).
      const resolved = (renderData && renderData[b.source]) || { rows: [] };
      pageBreakIfNeeded(50);
      space(4);
      if (b.label) {
        doc.fontSize(9).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text(b.label, left, doc.y, { width });
        space(3);
      }
      if (resolved.blocked) {
        doc.fontSize(9).fillColor('#B5462E').font('Helvetica-Oblique').text(resolved.message || 'Not on file.', left + 10, doc.y, { width: width - 10 });
        doc.font('Helvetica');
      } else if (!resolved.rows || !resolved.rows.length) {
        doc.fontSize(9).fillColor(GFC_COLORS.muted).font('Helvetica-Oblique').text('Not recorded.', left + 10, doc.y, { width: width - 10 });
        doc.font('Helvetica');
      } else {
        resolved.rows.forEach(r => {
          pageBreakIfNeeded(26);
          const rowY = doc.y;
          doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica-Bold').text(r.label, left + 10, rowY, { width: 150 });
          const labelBottom = doc.y;
          doc.fontSize(9).fillColor(GFC_COLORS.ink).font('Helvetica').text(r.value, left + 168, rowY, { width: width - 178 });
          doc.y = Math.max(labelBottom, doc.y) + 2;
        });
      }
      space(6);
    }
  });
}

/**
 * Generate the executed copy of ONE consent for one client.
 *
 * @param {Object} client                 the client user record
 * @param {string} consentType            a key in the consent registry
 * @param {Object} opts
 * @param {Object} opts.def               the registry entry (title, scope, required)
 * @param {string} opts.status            signed | signed_offline | optin_recorded | na | pending
 * @param {Object} opts.meta              the consent record (typedName, signedAt, ipHash, version, choices)
 * @param {boolean} opts.internal         staff copy — prints the internal review banner
 * @returns {Promise<Buffer>}
 */
// The client record each copy of a consent is rendered from. Only the
// provider Release of Information splits: one copy per named prior provider,
// the same office listed twice (spelling, case) counted once.
function consentProviderCopies(consentType, client) {
  if (consentType !== 'roiProvider') return [client];
  const seen = new Set();
  const list = (Array.isArray(client.priorProviders) ? client.priorProviders : []).filter(pp => {
    const key = String((pp && pp.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (list.length < 2) return [client];
  return list.map(pp => ({ ...client, priorProviders: [pp] }));
}

async function generateConsentPDF(client, consentType, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const def = opts.def || {};
      const meta = opts.meta || {};
      const status = opts.status || 'pending';
      // The version AS PRESENTED AT SIGNING. Never the current text for a
      // consent signed against an earlier one.
      const version = meta.version || consentText.currentVersion(consentType) || consentText.CURRENT_VERSION;
      const blocks = consentText.bodyFor(consentType, version);
      const title = def.title || consentText.titleFor(consentType);
      const clientLabel = consentRender.clientName(client) || 'Client';

      // The Release of Information to providers prints ONE PAGE PER PROVIDER
      // (owner, 2026-10-28), as its own wording says ("Complete one page for
      // each provider"): each copy names only the provider it goes to, so a
      // page faxed to one office never lists the others. Every other consent,
      // and a provider release with one or no provider, is a single copy.
      const copies = consentProviderCopies(consentType, client);

      const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 50, W = 512;

      copies.forEach((copyClient, copyIdx) => {
      if (copyIdx > 0) doc.addPage();
      const renderData = consentRender.resolveForConsent(consentText, consentType, copyClient);
      // A blank copy shows every election unmarked, for the client to tick by hand.
      renderData.__choices = opts.blank ? {} : (meta.choices || {});

      doc.fontSize(17).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text('Godwins Family Care', L, 40);
      doc.fontSize(11.5).fillColor(GFC_COLORS.gold).font('Helvetica-Bold').text(title, L, 63, { width: W });
      doc.moveTo(L, 84).lineTo(L + W, 84).strokeColor(GFC_COLORS.gold).lineWidth(2).stroke();

      doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica');
      doc.text(`${clientLabel}${(client.intake && client.intake.dob) || client.dob ? `  ·  DOB ${(client.intake && client.intake.dob) || client.dob}` : ''}`, L, 92, { width: W * 0.6 });
      doc.text(`Document version ${version}`, L, 92, { width: W, align: 'right' });
      if (opts.blank) {
        doc.fontSize(8).fillColor(GFC_COLORS.gold).font('Helvetica-Bold')
          .text('FOR SIGNATURE — this copy is not yet signed', L, 104, { width: W });
        doc.font('Helvetica');
      }

      doc.y = opts.blank ? 122 : 114;
      doc.x = L;
      renderConsentBody(doc, blocks, renderData, { left: L, width: W });

      // ---- signature block ----
      if (doc.y + 130 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      doc.y += 14;
      doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(GFC_COLORS.line).lineWidth(1).stroke();
      doc.y += 12;
      doc.fontSize(11).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text('Signature', L, doc.y, { width: W });
      doc.y += 6;

      const sigRow = (label, value) => {
        const y0 = doc.y;
        doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica-Bold').text(label, L, y0, { width: 150 });
        const b1 = doc.y;
        doc.fontSize(9.5).fillColor(GFC_COLORS.ink).font('Helvetica').text(value, L + 158, y0, { width: W - 158 });
        doc.y = Math.max(b1, doc.y) + 4;
      };

      if (opts.blank) {
        // A copy to carry to the client and sign by hand. Ruled lines, not an
        // executed block: nothing here may read as though it has been signed.
        // Staff scan it back in and the scan is what records the consent.
        doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica')
          .text('Sign below. Return the signed copy to Godwins Family Care; it is filed against your record and you keep a copy.', L, doc.y, { width: W });
        doc.y += 16;
        const rule = (label, x, width) => {
          const yLine = doc.y + 20;
          doc.moveTo(x, yLine).lineTo(x + width, yLine).strokeColor(GFC_COLORS.line).lineWidth(1).stroke();
          doc.fontSize(8).fillColor(GFC_COLORS.muted).font('Helvetica').text(label, x, yLine + 4, { width });
        };
        rule('Signature of client or authorized representative', L, 300);
        rule('Date', L + 320, 192);
        doc.y += 46;
        rule('Printed name', L, 300);
        rule('Relationship, if signing for the client', L + 320, 192);
        doc.y += 46;
        rule('Recorded by (Godwins Family Care staff)', L, 300);
        rule('Date recorded', L + 320, 192);
        doc.y += 40;
      } else if (status === 'signed') {
        // A POA signing for the client is named as such, never as the client.
        sigRow('Electronically signed by', meta.signedAs || meta.typedName || clientLabel);
        sigRow('Signed', meta.signedAt ? new Date(meta.signedAt).toLocaleString('en-US') : 'Not recorded');
        // The raw address is never retained; a truncated salted hash is enough
        // to tie this signature to its capture without holding PII.
        sigRow('Signer verification', meta.ipHash ? String(meta.ipHash).slice(0, 24) : 'Not recorded');
        sigRow('Method', 'Typed name and acknowledgment, captured in the client portal');
      } else if (status === 'signed_offline') {
        sigRow('Signed on paper', meta.signedAt ? new Date(meta.signedAt).toLocaleDateString('en-US') : 'Date not recorded');
        sigRow('Recorded by', meta.recordedByName || meta.recordedBy || 'Godwins Family Care staff');
        sigRow('Method', 'Wet signature on the paper packet; the original is on file');
      } else if (status === 'optin_recorded' || status === 'na') {
        sigRow('Status', status === 'na' ? 'Declined / not applicable' : 'Preference recorded');
        sigRow('Recorded', meta.recordedAt ? new Date(meta.recordedAt).toLocaleString('en-US') : 'Not recorded');
        sigRow('Method', 'Preference only — this option is not live, so no consent was executed and no signature was taken');
      } else {
        sigRow('Status', 'Not signed');
      }

      // A blank copy never restates an election as made: the client ticks it by
      // hand on the page. Printing "I consent to telehealth visits" under a
      // signature line nobody has signed yet is exactly the wrong thing to hand
      // someone.
      Object.keys(opts.blank ? {} : (meta.choices || {})).forEach(k => {
        const c = consentText.choicesFor(consentType).find(x => x.key === k);
        const opt = c && (c.options || []).find(o => o.value === meta.choices[k]);
        if (c) sigRow(c.label, (opt && opt.label) || meta.choices[k]);
      });

      doc.y += 10;
      doc.fontSize(7.5).fillColor(GFC_COLORS.muted).font('Helvetica')
        .text(`${consentText.ORG.name} · ${consentText.ORG.address} · ${consentText.ORG.phone}. Generated ${new Date().toLocaleString('en-US')}. ` + (opts.blank
          ? 'Document version ' + version + '. Once signed and returned, this consent is recorded against your file and a copy is available in your portal.'
          : 'This is your copy of the document you signed; keep it with your records.'), L, doc.y, { width: W });
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}


// ============================================================
// Client Information Face Sheet
//
// Five consents point at it — "recorded once on your Client Information Face
// Sheet" — and it existed nowhere in the app. It is ASSEMBLED from the client
// record and the intake rather than collected again, which is the entire reason
// those consents stopped repeating the questions.
//
// Its own header and footer helpers rather than the consent PDF's: a face sheet
// is a reference card, not an executed document, and it carries no signature
// block, no version pin and no "this is your copy of what you signed" line.
// ============================================================
function faceSheetHeader(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 92).fill(GFC_COLORS.navy);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15).text(consentText.ORG.name, 50, 26);
  doc.font('Helvetica').fontSize(8.5).fillColor(GFC_COLORS.gold)
    .text(`${consentText.ORG.address}  ·  Tel ${consentText.ORG.phone}  ·  Fax ${consentText.ORG.fax}`, 50, 46);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text(title, 50, 63, { width: 500 });
  if (subtitle) doc.font('Helvetica').fontSize(8).fillColor(GFC_COLORS.gold).text(subtitle, 50, 79, { width: 500 });
  doc.fillColor(GFC_COLORS.ink);
  return 112;
}

// Stamp the footer on every page AFTER the content is laid out. Writing below
// the bottom margin during the flow makes pdfkit add a page for the overflow,
// which is what produced footer-only pages in the middle of the document.
function faceSheetFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 42;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).strokeColor(GFC_COLORS.gold).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(GFC_COLORS.muted)
      .text(`Care That Sees You. ${consentText.ORG.name} · ${consentText.ORG.phone}`, 50, y + 7, { width: 500, lineBreak: false });
    if (range.count > 1) {
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, 50, y + 7, { width: 512, align: 'right', lineBreak: false });
    }
    doc.page.margins.bottom = saved;
  }
}

async function generateFaceSheetPDF(client) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(res => doc.on('end', res));

  const c = client || {};
  const i = c.intake || {};
  const L = 50, W = doc.page.width - 100;
  let y = faceSheetHeader(doc, 'Client Information Face Sheet',
    `${c.name || 'Client'}${c.serviceLine ? '  ·  ' + String(c.serviceLine).toUpperCase() : ''}  ·  Generated ${new Date().toLocaleDateString('en-US')}`);

  const section = (t) => {
    if (y + 60 > doc.page.height - 60) { doc.addPage(); y = 56; }
    doc.rect(L, y, W, 18).fill('#FAF7F2');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GFC_COLORS.navy).text(t.toUpperCase(), L + 8, y + 5, { characterSpacing: 0.5 });
    y += 26;
  };
  const pair = (label, value) => {
    if (y + 26 > doc.page.height - 60) { doc.addPage(); y = 56; }
    doc.font('Helvetica').fontSize(7).fillColor(GFC_COLORS.muted).text(String(label).toUpperCase(), L, y, { width: 150, characterSpacing: 0.3 });
    doc.font('Helvetica').fontSize(9.5).fillColor(GFC_COLORS.ink).text(value == null || value === '' ? '\u2014' : String(value), L + 158, y, { width: W - 158 });
    y = Math.max(doc.y, y + 13) + 5;
  };
  const listOf = (arr, fn) => (Array.isArray(arr) && arr.length) ? arr.map(fn).filter(Boolean).join('; ') : null;

  section('Client');
  pair('Full legal name', c.name || i.clientLegalName);
  pair('Preferred name', c.preferredName || i.preferredName);
  pair('Date of birth', i.dob || c.dob);
  pair('Address', i.address || c.address);
  pair('Phone', i.phone || c.phone);
  pair('Service line', c.serviceLine);
  pair('Care tier', c.careTier);

  section('Emergency contacts and call order');
  const pc = i.primaryContact || {};
  pair('Primary contact', [pc.name, pc.relationship, pc.phone].filter(Boolean).join(' \u2014 '));
  const ec = i.emergencyContact || {};
  pair('Emergency contact', [ec.name, ec.relationship, ec.phone].filter(Boolean).join(' \u2014 '));
  pair('Notify first in a crisis', i.crisisNotify);
  pair('Authorized to call 911', i.auth911);

  section('Medical');
  const mt = i.medicalTeam || {};
  pair('Primary care provider', mt.pcpName || i.pcpName);
  pair('Preferred hospital', mt.preferredHospital || i.preferredHospital);
  pair('Pharmacy', [mt.preferredPharmacy, mt.pharmacyPhone].filter(Boolean).join(' \u2014 '));
  pair('Allergies', c.allergies || i.allergies);
  pair('Diagnoses', listOf(i.diagnoses, d => (typeof d === 'string' ? d : d && (d.label || d.code))));
  pair('Medications', listOf(i.medications, m => m && m.name ? [m.name, m.dose, m.frequency].filter(Boolean).join(' ') : null));

  section('Advance directive and decision making');
  const ad = i.advanceDirective || {};
  pair('Advance directive', ad.status || i.advanceDirectiveStatus);
  pair('Healthcare agent', ad.agentName || i.healthcareAgent);
  pair('Power of attorney on file', ad.poaOnFile != null ? (ad.poaOnFile ? 'Yes' : 'No') : null);

  section('Home and access');
  pair('Entry instructions', i.entryInstructions);
  pair('Pets in the home', i.pets);
  pair('Home safety notes', listOf(c.homeSafetyFlags, f => f));

  section('Payer');
  const payer = c.payer || {};
  pair('Payer type', payer.type);
  pair('Plan', payer.planName);
  pair('Billing contact', payer.billingContact);

  y += 6;
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(GFC_COLORS.muted).text(
    'Assembled from this client\u2019s record. Confirm it is correct rather than writing it again, and tell us whenever it changes.',
    L, y, { width: W });

  faceSheetFooters(doc);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

// ============================================================
// Transfer-of-Care Provider ROI PDF (Session 3.4)
//
// One PDF per authorized prior provider, matching the layout and brand tokens
// of renderROIHtml() in docs/source-forms/gfc_roi_upload.gs (navy #033D50, gold
// #F5CD85, cream #FAF7F2, serif display + sans body). The legacy handler built
// HTML→PDF; this repo renders PDFs with pdfkit, so the layout is reproduced with
// pdfkit primitives (navy section bars w/ gold numerals, checkbox glyphs, a
// canvas-signature image). The static Rights (revocation) and Redisclosure
// blocks are rendered verbatim so the 45 CFR 164.508 elements are always present.
//
// TEST DATA ONLY until HIPAA-live.
// ============================================================

// GFC ROI brand tokens (mirror the .gs renderer).
const ROI_COLORS = { navy: '#033D50', gold: '#F5CD85', goldRule: '#C9A44A', cream: '#FAF7F2', ink: '#1a1a1a', muted: '#666666', line: '#BBBBBB' };

const ROI_ORG = {
  name: 'Godwins Family Care LLC',
  address: '4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339',
  tel: '404-913-6705',
  fax: '678-692-7445'
};

// Verbatim static blocks — required 45 CFR 164.508 elements (right to revoke +
// redisclosure). Kept identical to the legacy form / portal consent language.
const AUTH_RIGHTS_TEXT =
  'I understand that: (1) I may revoke this authorization at any time by writing to Godwins Family Care LLC, ' +
  'except to the extent action has already been taken in reliance on it; (2) treatment, payment, enrollment, ' +
  'and eligibility for benefits may not be conditioned on signing, except where the law allows; (3) information ' +
  'disclosed under this authorization may be re-disclosed by the recipient and may no longer be protected by ' +
  'federal privacy law; and (4) I am entitled to a copy of this signed authorization.';

// Section-4 standard categories, in display order (label per the .gs renderer).
const ROI_CATEGORY_LABELS = {
  hp: 'History & physical / progress notes',
  lab: 'Lab and pathology results',
  diag: 'Problem & diagnosis list',
  imaging: 'Imaging / radiology reports',
  meds: 'Current medication list',
  discharge: 'Discharge summaries',
  allergies: 'Allergies',
  immune: 'Immunization records',
  other: 'Other'
};

// ============================================================================
// A CAREGIVER'S VISIT LOG, AS A DOCUMENT
// ============================================================================
// The office could read a visit log on screen and had nothing to file, hand to
// a family member or attach to an email (owner, 2026-10-03). This renders the
// submitted log and its review trail.
//
// It prints what the log SAYS and nothing it does not: no pay rate, no
// geofence verdict, no distance. Those are between the agency and its
// caregiver, and a document that travels should not carry them. The log is
// immutable, so a review note appears as what it is — appended, with its own
// author and timestamp — never folded into the body as though it had been
// there all along.
//
// `d` is the shape `publicVisitLog` already serves, so the screen and the
// document are reading one projection rather than two.
async function generateVisitLogPDF(d) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const detail = (d && d.detail) || {};
  const W = 512;
  let y = faceSheetHeader(doc, 'Caregiver Visit Log',
    `${d.clientName || ''}${d.visitDate ? '  ·  ' + gfcTime.fmtDate(`${d.visitDate}T12:00:00Z`) : ''}`);

  const heading = (text) => {
    if (y > doc.page.height - 130) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GFC_COLORS.navy).text(text, 50, y, { width: W });
    y = doc.y + 4;
    doc.moveTo(50, y).lineTo(50 + W, y).lineWidth(0.5).strokeColor(GFC_COLORS.gold).stroke();
    y += 8;
  };
  const line = (label, value) => {
    if (y > doc.page.height - 110) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GFC_COLORS.muted).text(label, 50, y, { width: 150 });
    doc.font('Helvetica').fontSize(9).fillColor(GFC_COLORS.ink)
      .text(String(value === null || value === undefined || value === '' ? '—' : value), 205, y, { width: W - 155 });
    y = Math.max(doc.y, y + 12) + 3;
  };
  const para = (text) => {
    if (y > doc.page.height - 110) { doc.addPage(); y = 50; }
    doc.font('Helvetica').fontSize(9).fillColor(GFC_COLORS.ink).text(String(text || ''), 50, y, { width: W });
    y = doc.y + 6;
  };

  heading('The visit');
  line('Client', d.clientName || d.clientId);
  line('Caregiver', d.caregiverName);
  line('License level', d.licenseLevel ? String(d.licenseLevel).toUpperCase() : '');
  line('Visit type', d.visitType);
  line('Visit date', d.visitDate ? gfcTime.fmtDate(`${d.visitDate}T12:00:00Z`) : '');
  line('Filed', gfcTime.fmtDateTime(d.submittedAt));
  line('Status', String(d.status || '').replace(/_/g, ' '));
  if (d.submittedOffline) line('Filed offline', 'Yes — queued on the device and sent later');

  if ((detail.tasks || []).length > 0) {
    heading('Care provided');
    // Grouped the way the form groups them, so a reviewer reads it in the
    // order the caregiver filled it in.
    let group = null;
    for (const t of detail.tasks) {
      if (t.group !== group) {
        group = t.group;
        if (y > doc.page.height - 110) { doc.addPage(); y = 50; }
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GFC_COLORS.muted).text(group, 50, y, { width: W });
        y = doc.y + 3;
      }
      // A task recorded as NOT done, with a reason, is the row a reviewer most
      // needs to see — it is marked rather than dropped.
      const mark = t.done ? '✓' : '✗';
      const suffix = t.done ? '' : '  (not done)';
      para(`   ${mark}  ${t.label}${suffix}${t.note ? ' — ' + t.note : ''}`);
    }
  }

  if ((detail.measurements || []).length > 0) {
    heading('Measurements');
    detail.measurements.forEach(m => line(m.label, m.value));
  }

  if ((detail.patientCondition || []).length > 0 || detail.satisfaction) {
    heading('How the client was');
    if ((detail.patientCondition || []).length > 0) line('Observed', detail.patientCondition.join(', '));
    if (detail.satisfaction) line('Client satisfaction', detail.satisfaction);
  }

  if ((detail.safetyConcerns || []).length > 0) {
    heading('Safety concerns raised');
    para(detail.safetyConcerns.join(', '));
  }

  if ((detail.standingInstructionsAcknowledged || []).length > 0) {
    heading('Standing instructions acknowledged');
    detail.standingInstructionsAcknowledged.forEach(s => para(`   ·  ${s}`));
  }

  if ((detail.narratives || []).length > 0) {
    heading('Notes');
    detail.narratives.forEach(n => {
      if (y > doc.page.height - 110) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GFC_COLORS.muted).text(n.label, 50, y, { width: W });
      y = doc.y + 2;
      para(n.value);
    });
  }

  // Appended, never merged into the body above: this log is immutable and the
  // review trail is its own append-only record.
  if ((d.reviews || []).length > 0) {
    heading('Review notes (appended after filing)');
    d.reviews.forEach(r => {
      para(`${r.byName || ''} · ${gfcTime.fmtDateTime(r.at)}`);
      para(r.note || '');
    });
  }

  if (y > doc.page.height - 120) { doc.addPage(); y = 50; }
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(GFC_COLORS.muted)
    .text('A submitted visit log is never edited. Corrections are appended above, each with its own author and timestamp.',
      50, y + 6, { width: W });

  faceSheetFooters(doc);
  doc.end();
  return done;
}

/**
 * Generate one Transfer-of-Care ROI PDF for a single provider.
 *
 * @param {Object} d
 * @param {string} d.patientName
 * @param {string} d.patientDOB
 * @param {string} d.patientAddress
 * @param {string} d.patientPhone
 * @param {Object} d.provider  - { name, dept, address, phone, fax }
 * @param {Object} d.categories - { hp,lab,diag,imaging,meds,discharge,allergies,immune,other:bool, otherText }
 * @param {boolean} d.includesProtected - the 42 CFR Part 2 opt-in (defaults false)
 * @param {boolean} d.purposeTreatment
 * @param {boolean} d.purposeOther
 * @param {string}  d.purposeOtherText
 * @param {string}  d.expDate
 * @param {string}  d.expEvent
 * @param {string}  d.signatureImageB64 - canvas capture data URI
 * @param {string}  d.signedDate
 * @param {string}  d.printedName
 * @param {string}  d.relationship
 * @returns {Promise<Buffer>}
 */
// Plain-text value for a form field. A structured address (or any object) is
// flattened rather than printed as "[object Object]"; null/undefined is blank.
function roiText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.map(roiText).filter(Boolean).join(', ');
    const parts = [v.street || v.line1 || v.address1, v.line2 || v.address2 || v.unit, v.city,
      [v.state, v.zip || v.postalCode].filter(Boolean).join(' ')];
    return parts.map(p => String(p || '').trim()).filter(Boolean).join(', ');
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

// A date as MM/DD/YYYY. A bare YYYY-MM-DD is read as a calendar date (never
// through the clock, which would move it a day in Georgia's evening); anything
// unparseable is printed as typed rather than dropped.
function roiDate(v) {
  const s = roiText(v);
  if (!s) return '';
  // Only a BARE date is a calendar date. A full timestamp goes through the
  // clock in Georgia, or an evening signing prints as tomorrow.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' });
}

// ONE page, built to survive a fax:
//  - checkboxes are DRAWN (an outlined box, a stroked check when ticked). The
//    old version printed the ☑/☐ characters in Helvetica, which cannot encode
//    them, so every box came out as "&" ticked or not: a provider could not
//    tell which records were asked for, and the specially protected line read
//    as authorized when the patient had said no.
//  - the protected-information answer is ALSO written in words, so it survives
//    a fax that loses the box.
//  - the patient, date of birth and provider are on every page, top and
//    bottom, so a page that gets separated can still be matched.
//  - the expiration printed is the date that actually applies, never a blank.
async function generateProviderROIPDF(d) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margins: { top: 36, bottom: 36, left: 40, right: 40 }, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 40, R = 612 - 40, W = R - L;
      const BOTTOM = 792 - 38; // keep clear of the identifier strip
      const cat = d.categories || {};
      const provider = d.provider || {};
      const patientName = roiText(d.patientName);
      const patientDOB = roiDate(d.patientDOB);
      const providerName = roiText(provider.name);
      let y = 50;

      const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 50; } };

      // `room` is what the section needs below its bar, so a bar is never
      // left alone at the foot of a page with its content on the next.
      const section = (num, label, room = 30) => {
        ensure(24 + room);
        y += 4;
        doc.rect(L, y, W, 15).fill(ROI_COLORS.navy);
        doc.fontSize(8.5).fillColor(ROI_COLORS.gold).font('Helvetica-Bold').text(String(num), L + 7, y + 4, { lineBreak: false });
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
          .text(label.toUpperCase(), L + 20, y + 4, { characterSpacing: 0.5, lineBreak: false });
        y += 20;
        doc.fillColor(ROI_COLORS.ink);
      };

      // Values wrap (up to two lines) rather than being cut off: a provider's
      // name or address truncated on a release is a release nobody can act on.
      const fieldRow = (fields) => {
        const gap = 14;
        const totalW = W - gap * (fields.length - 1);
        const weights = fields.map(f => f.weight || 1);
        const sum = weights.reduce((a, b) => a + b, 0);
        doc.fontSize(10).font('Helvetica');
        const cols = fields.map((f, i) => {
          const w = totalW * weights[i] / sum;
          const text = roiText(f.value) || ' ';
          return { f, w, text, h: Math.min(24, doc.heightOfString(text, { width: w })) };
        });
        const valueH = Math.max(12, ...cols.map(c => c.h));
        ensure(valueH + 16);
        let x = L;
        cols.forEach(c => {
          doc.fontSize(6.5).fillColor(ROI_COLORS.muted).font('Helvetica').text((c.f.label || '').toUpperCase(), x, y, { width: c.w, characterSpacing: 0.3, lineBreak: false });
          doc.fontSize(10).fillColor(ROI_COLORS.ink).font('Helvetica').text(c.text, x, y + 8, { width: c.w, height: 24, ellipsis: true });
          doc.moveTo(x, y + 10 + valueH).lineTo(x + c.w, y + 10 + valueH).strokeColor(ROI_COLORS.line).lineWidth(0.6).stroke();
          x += c.w + gap;
        });
        y += valueH + 16;
      };

      // A drawn checkbox: outlined square, plus a heavy check stroke when on.
      const box = (x, yy, on) => {
        doc.lineWidth(0.9).strokeColor('#000000').rect(x, yy, 9, 9).stroke();
        if (on) {
          doc.lineWidth(1.6).strokeColor('#000000')
            .moveTo(x + 1.8, yy + 4.6).lineTo(x + 3.9, yy + 7).lineTo(x + 7.6, yy + 1.8).stroke();
        }
      };
      const checkLine = (on, label, opts = {}) => {
        const w = W - 16;
        doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
        const h = Math.max(13, doc.heightOfString(label, { width: w }) + 3);
        ensure(h);
        box(L, y, on);
        doc.fillColor(ROI_COLORS.ink).text(label, L + 15, y, { width: w });
        y += h;
      };

      // ── Header ───────────────────────────────────────────────
      doc.fontSize(12).fillColor(ROI_COLORS.navy).font('Helvetica-Bold').text(ROI_ORG.name, L, y, { lineBreak: false });
      doc.fontSize(7.5).fillColor(ROI_COLORS.muted).font('Helvetica')
        .text(`${ROI_ORG.address}   Tel ${ROI_ORG.tel}   Fax ${ROI_ORG.fax}`, L, y + 3, { width: W, align: 'right', lineBreak: false });
      y += 18;
      doc.rect(L, y, W, 1.5).fill(ROI_COLORS.goldRule);
      y += 8;

      doc.fontSize(17).fillColor(ROI_COLORS.navy).font('Times-Bold').text('Authorization to Obtain Medical Records', L, y, { lineBreak: false });
      y += 21;
      const intro = 'I authorize the provider or facility named below to release the medical records described to Godwins Family Care LLC, for the purpose of my treatment, care coordination, and care planning.';
      doc.fontSize(8.5).fillColor(ROI_COLORS.ink).font('Helvetica').text(intro, L, y, { width: W });
      y += doc.heightOfString(intro, { width: W }) + 2;

      // ── 1 Patient ────────────────────────────────────────────
      section(1, 'Patient (whose records)');
      fieldRow([{ label: 'Patient full name', value: patientName }, { label: 'Date of birth', value: patientDOB }]);
      fieldRow([{ label: 'Address', value: d.patientAddress }, { label: 'Phone', value: d.patientPhone }]);

      // ── 2 Release from ───────────────────────────────────────
      section(2, 'Release records from (provider or facility)');
      fieldRow([{ label: 'Provider / facility name', value: providerName, weight: 2 }, { label: 'Department', value: provider.dept }]);
      fieldRow([{ label: 'Address', value: provider.address, weight: 2 }, { label: 'Phone', value: provider.phone }, { label: 'Fax', value: provider.fax }]);

      // ── 3 Release to ─────────────────────────────────────────
      section(3, 'Release records to');
      ensure(26);
      doc.lineWidth(0.6).rect(L, y, W, 24).strokeColor('#999999').stroke();
      doc.fontSize(9.5).fillColor(ROI_COLORS.navy).font('Helvetica-Bold').text(ROI_ORG.name, L + 8, y + 4, { lineBreak: false });
      doc.fontSize(8).fillColor(ROI_COLORS.ink).font('Helvetica')
        .text(`${ROI_ORG.address}   Tel ${ROI_ORG.tel}   Fax ${ROI_ORG.fax}`, L + 8, y + 14, { width: W - 16, lineBreak: false });
      y += 30;

      // ── 4 Information authorized ─────────────────────────────
      section(4, 'Information authorized for release', 60);
      const catKeys = ['hp', 'lab', 'diag', 'imaging', 'meds', 'discharge', 'allergies', 'immune'];
      ensure(Math.ceil(catKeys.length / 2) * 13 + 4);
      const colW2 = W / 2;
      const gridTop = y;
      catKeys.forEach((k, i) => {
        const x = L + (i % 2) * colW2;
        const yy = gridTop + Math.floor(i / 2) * 13;
        box(x, yy, !!cat[k]);
        doc.fontSize(9).fillColor(ROI_COLORS.ink).font('Helvetica').text(ROI_CATEGORY_LABELS[k], x + 15, yy, { width: colW2 - 20, lineBreak: false });
      });
      y = gridTop + Math.ceil(catKeys.length / 2) * 13 + 1;
      checkLine(!!cat.other, 'Other: ' + (cat.other ? roiText(cat.otherText) : ''));
      const protNote = 'Specially protected information. Records of mental health, substance use treatment, HIV/AIDS, or genetic testing are released ONLY if specifically authorized here:';
      doc.fontSize(7.5).font('Helvetica-Oblique');
      ensure(doc.heightOfString(protNote, { width: W }) + 18);
      doc.fillColor(ROI_COLORS.muted).text(protNote, L, y + 1, { width: W });
      y += doc.heightOfString(protNote, { width: W }) + 3;
      const prot = d.includesProtected === true;
      checkLine(prot, prot
        ? 'YES: specially protected information IS authorized for release.'
        : 'NOT AUTHORIZED: do not release specially protected information.', { bold: true });

      // ── 5 Purpose ────────────────────────────────────────────
      section(5, 'Purpose of disclosure');
      checkLine(d.purposeTreatment !== false, 'Treatment, care coordination, and care planning');
      if (d.purposeOther && roiText(d.purposeOtherText)) checkLine(true, 'Other: ' + roiText(d.purposeOtherText));

      // ── 6 Expiration ─────────────────────────────────────────
      section(6, 'Expiration');
      fieldRow([
        { label: 'This authorization expires on', value: roiDate(d.expDate) || 'One year from the date signed' },
        { label: 'Or on this event, if sooner', value: roiText(d.expEvent) || 'None stated' }
      ]);

      // ── 7 Rights ─────────────────────────────────────────────
      section(7, 'Your rights', 44);
      doc.fontSize(8).font('Helvetica');
      const rightsH = doc.heightOfString(AUTH_RIGHTS_TEXT, { width: W, lineGap: 1 });
      ensure(rightsH + 4);
      doc.fillColor(ROI_COLORS.ink).text(AUTH_RIGHTS_TEXT, L, y, { width: W, lineGap: 1 });
      y += rightsH + 4;

      // ── 8 Signature ──────────────────────────────────────────
      section(8, 'Signature', 70);
      const sigTop = y;
      doc.fontSize(6.5).fillColor(ROI_COLORS.muted).font('Helvetica').text('SIGNATURE OF PATIENT OR PERSONAL REPRESENTATIVE', L, sigTop, { lineBreak: false });
      const sig = d.signatureImageB64;
      if (typeof sig === 'string' && sig.startsWith('data:image')) {
        try {
          doc.image(Buffer.from(sig.slice(sig.indexOf(',') + 1), 'base64'), L, sigTop + 7, { fit: [220, 28] });
        } catch (e) { /* unreadable image: leave the line blank rather than fail the form */ }
      }
      doc.moveTo(L, sigTop + 37).lineTo(L + 300, sigTop + 37).strokeColor(ROI_COLORS.line).lineWidth(0.6).stroke();
      doc.fontSize(6.5).fillColor(ROI_COLORS.muted).font('Helvetica').text('DATE SIGNED', L + 320, sigTop, { lineBreak: false });
      doc.fontSize(10).fillColor(ROI_COLORS.ink).font('Helvetica').text(roiDate(d.signedDate) || ' ', L + 320, sigTop + 20, { lineBreak: false });
      doc.moveTo(L + 320, sigTop + 37).lineTo(R, sigTop + 37).strokeColor(ROI_COLORS.line).lineWidth(0.6).stroke();
      y = sigTop + 42;
      fieldRow([{ label: 'Printed name', value: d.printedName }, { label: 'If representative, relationship / authority', value: d.relationship }]);

      // Identifiers on every page, top and bottom. Margins are dropped first so
      // writing near the edge can never make pdfkit add a page of its own.
      const range = doc.bufferedPageRange();
      const ident = `Patient: ${patientName || '—'}   ·   DOB: ${patientDOB || '—'}   ·   Release from: ${providerName || '—'}`;
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.top = 0; doc.page.margins.bottom = 0;
        const page = `Page ${i - range.start + 1} of ${range.count}`;
        doc.fontSize(7).fillColor('#000000').font('Helvetica');
        doc.text(ident, L, 22, { width: W - 70, lineBreak: false, ellipsis: true });
        doc.text(page, L, 22, { width: W, align: 'right', lineBreak: false });
        doc.text(ident, L, 792 - 28, { width: W - 70, lineBreak: false, ellipsis: true });
        doc.text(page, L, 792 - 28, { width: W, align: 'right', lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================
// Care Plan / Service Plan PDF (Session 4.1, spec §4.3 signed-PDF rule)
//
// One document, its OWN signatures respectively: the RN author signature and
// the client (or representative) co-signature — each rendered as the captured
// signature image + printed name + timestamp + IP verification hash. Emitted
// in two states:
//   - authored  (RN signed, client line blank, "PENDING CLIENT CO-SIGNATURE")
//   - signed    (both signatures populated — the final legal artifact)
// A plan that needs a provider's co-signature carries a third block
// (d.providerSignature), shown as pending until the provider signs.
// Brand: navy/gold/cream per ROI_COLORS (the 3.4 reference pattern).
// ============================================================
async function generateCarePlanPDF(d) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 44, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 44, R = 612 - 44, W = R - L;
      const plan = d.plan || {};
      const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
      const fmtTs = (iso) => iso ? new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
      let y = 40;

      const section = (num, label) => {
        if (y > 690) { doc.addPage(); y = 44; }
        y += 6;
        doc.rect(L, y, W, 17).fill(ROI_COLORS.navy);
        doc.fontSize(9).fillColor(ROI_COLORS.gold).font('Helvetica-Bold').text(String(num), L + 8, y + 4.5);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
          .text(label.toUpperCase(), L + 22, y + 5, { characterSpacing: 0.6 });
        y += 24;
        doc.fillColor(ROI_COLORS.ink);
      };
      const bullets = (items) => {
        for (const it of (items || [])) {
          if (y > 720) { doc.addPage(); y = 44; }
          doc.circle(L + 4, y + 5, 1.8).fill(ROI_COLORS.goldRule);
          doc.fontSize(9.5).fillColor(ROI_COLORS.ink).font('Helvetica').text(String(it), L + 14, y, { width: W - 14 });
          y += Math.max(14, doc.heightOfString(String(it), { width: W - 14 }) + 4);
        }
      };
      const fieldRow = (fields) => {
        if (y > 715) { doc.addPage(); y = 44; }
        const gap = 16;
        const colW = (W - gap * (fields.length - 1)) / fields.length;
        fields.forEach((f, i) => {
          const x = L + i * (colW + gap);
          doc.fontSize(7).fillColor(ROI_COLORS.muted).font('Helvetica').text((f.label || '').toUpperCase(), x, y, { width: colW, characterSpacing: 0.4 });
          doc.fontSize(10.5).fillColor(ROI_COLORS.ink).font('Helvetica').text(f.value || ' ', x, y + 10, { width: colW });
          doc.moveTo(x, y + 26).lineTo(x + colW, y + 26).strokeColor(ROI_COLORS.line).lineWidth(0.7).stroke();
        });
        y += 36;
      };
      // One signature block: image + printed name + timestamp + IP hash.
      const signatureBlock = (label, sig) => {
        if (y > 640) { doc.addPage(); y = 44; }
        const top = y;
        doc.fontSize(7).fillColor(ROI_COLORS.muted).font('Helvetica').text(label.toUpperCase(), L, top);
        const img = sig && sig.signatureImage;
        if (typeof img === 'string' && img.startsWith('data:image')) {
          try {
            const buf = Buffer.from(img.slice(img.indexOf(',') + 1), 'base64');
            doc.image(buf, L, top + 10, { fit: [240, 46] });
          } catch (e) { /* non-fatal: leave signature area blank */ }
        } else if (sig && sig.pending) {
          doc.fontSize(9).fillColor(ROI_COLORS.muted).font('Helvetica-Oblique')
            .text('Pending signature', L, top + 26);
        }
        doc.moveTo(L, top + 58).lineTo(L + 300, top + 58).strokeColor(ROI_COLORS.line).lineWidth(0.7).stroke();
        doc.fontSize(7).fillColor(ROI_COLORS.muted).font('Helvetica').text('SIGNED (DATE & TIME)', L + 330, top);
        doc.fontSize(10).fillColor(ROI_COLORS.ink).font('Helvetica').text(sig && sig.at ? fmtTs(sig.at) : ' ', L + 330, top + 12);
        doc.moveTo(L + 330, top + 58).lineTo(R, top + 58).strokeColor(ROI_COLORS.line).lineWidth(0.7).stroke();
        y = top + 66;
        fieldRow([
          { label: 'Printed name', value: (sig && sig.name) || '' },
          { label: 'IP verification (hashed)', value: sig && sig.ipHash ? String(sig.ipHash).slice(0, 16) : '' }
        ]);
        // Session 4.3 (spec §4.3): a designated POA signs under their OWN name
        // ("<POA> as POA for <client>", already the printed name above) and the
        // block says so — the client is never presented as the signer.
        if (sig && sig.signerRole === 'poa') {
          doc.fontSize(8).fillColor(ROI_COLORS.muted).font('Helvetica-Oblique')
            .text('Signed by the client\'s designated Power of Attorney (POA designation verified on file by Godwins Family Care).', L, y - 6, { width: W });
          y += 10;
        }
      };

      // ── Header ──
      doc.fontSize(13).fillColor(ROI_COLORS.navy).font('Helvetica-Bold').text(ROI_ORG.name, L, y);
      doc.fontSize(8).fillColor(ROI_COLORS.muted).font('Helvetica')
        .text(`${ROI_ORG.address}   Tel ${ROI_ORG.tel}   Fax ${ROI_ORG.fax}`, L, y + 17, { width: W, align: 'right' });
      y += 30;
      doc.rect(L, y, W, 2).fill(ROI_COLORS.goldRule);
      y += 12;
      doc.fontSize(21).fillColor(ROI_COLORS.navy).font('Times-Bold').text('Care Plan / Service Plan', L, y);
      y += 28;
      doc.fontSize(9).fillColor(ROI_COLORS.muted).font('Times-Italic')
        .text(`Version ${plan.version ?? '—'} · authored ${fmt(plan.authoredAt)}${plan.authoredBy ? ` · ${plan.authoredBy}` : ''}`, L, y, { width: W });
      y += 16;
      // A plan that needs a provider's signature (IHPC authored by an RN, or
      // any LMSW-authored plan) says so on the document. The version row keeps
      // the status as it was at authoring ('pending'); the signature itself is
      // what shows whether it has landed.
      const providerRequired = ['pending', 'complete'].includes(plan.providerCoSignStatus) || !!(d.providerSignature && d.providerSignature.signatureImage);
      const providerSigned = !!(d.providerSignature && d.providerSignature.signatureImage);
      const banner = (text) => {
        doc.rect(L, y, W, 20).fillAndStroke('#FDF6E7', ROI_COLORS.goldRule);
        doc.fontSize(9).fillColor('#9a6a1e').font('Helvetica-Bold').text(text, L + 10, y + 6);
        y += 30;
      };
      if (d.state === 'authored') banner('PENDING CLIENT CO-SIGNATURE — not yet in effect');
      if (providerRequired && !providerSigned) banner('PENDING CLINICIAN CO-SIGNATURE — not yet in effect');

      // ── 1 Patient ──
      section(1, 'Patient');
      fieldRow([{ label: 'Patient name', value: d.patientName }, { label: 'Date of birth', value: d.patientDOB }]);
      fieldRow([{ label: 'Care track', value: d.careTierLabel || d.careTier || '' }, { label: 'Service line', value: d.serviceLine || '' }]);

      // The 2026-10-14 format (carePlanFormat.js) when the plan carries it;
      // the original layout for a plan written before it. Goal STATUS is not
      // printed: it changes without a new version, so a signed PDF would
      // show a status that is no longer true.
      const structured = Array.isArray(plan.goalItems);
      let n = 1;
      const next = (label) => section(++n, label);
      const para = (text, opts = {}) => {
        if (!text) return;
        if (y > 720) { doc.addPage(); y = 44; }
        doc.fontSize(opts.size || 9.5).fillColor(opts.color || ROI_COLORS.ink).font(opts.font || 'Helvetica').text(String(text), L + (opts.indent || 0), y, { width: W - (opts.indent || 0) });
        y += doc.heightOfString(String(text), { width: W - (opts.indent || 0) }) + (opts.after == null ? 4 : opts.after);
      };
      const LBL = {
        responsible: { gfc_clinician: 'GFC clinician', gfc_caregiver: 'GFC caregiver', family: 'Family', patient: 'Patient', outside_agency: 'Outside agency' },
        frequency: { daily: 'Daily', each_visit: 'Each visit', weekly: 'Weekly', as_needed: 'As needed', one_time: 'One time', ongoing: 'Ongoing' },
        managedBy: { patient: 'The patient', family: 'Family', caregiver: 'Caregiver (reminders)', pharmacy_pack: 'Pharmacy blister pack', clinician: 'GFC clinician' },
        cadence: { '30_days': 'Every 30 days', '60_days': 'Every 60 days', '90_days': 'Every 90 days', '6_months': 'Every 6 months', '12_months': 'Every 12 months' }
      };

      if (!structured) {
        next('Problems addressed');
        bullets(plan.problems);
        next('Goals & objectives');
        bullets(plan.goals);
      } else {
        next('Problems');
        for (const p of plan.problemItems || []) {
          para(p.text, { font: 'Helvetica-Bold', after: 2 });
          if (p.prognosis) para(`Prognosis: ${p.prognosis}`, { indent: 10, after: 2 });
          if (p.expectedOutcome) para(`Expected outcome: ${p.expectedOutcome}`, { indent: 10 });
        }
        next('Goals');
        const problemText = new Map((plan.problemItems || []).map(p => [p.id, p.text]));
        for (const g of plan.goalItems) {
          const tags = [g.priority && `${g.priority[0].toUpperCase()}${g.priority.slice(1)} priority`, g.patientStated && "patient's own goal"].filter(Boolean).join(' · ');
          para(g.statement, { font: 'Helvetica-Bold', after: 2 });
          if (tags) para(tags, { indent: 10, size: 8.5, color: ROI_COLORS.muted, after: 2 });
          if (g.problemId && problemText.get(g.problemId)) para(`For: ${problemText.get(g.problemId)}`, { indent: 10, after: 2 });
          const m = [g.measure && `Measure: ${g.measure}`, g.baseline && `Baseline ${g.baseline}`, g.target && `Target ${g.target}`, g.targetDate && `by ${fmt(g.targetDate)}`].filter(Boolean).join(' · ');
          if (m) para(m, { indent: 10 });
        }
        if ((plan.interventions || []).length) {
          next('Interventions');
          const goalText = new Map(plan.goalItems.map(g => [g.id, g.statement]));
          for (const i of plan.interventions) {
            para(i.description, { after: 2 });
            const forGoals = (i.goalIds || []).map(id => goalText.get(id)).filter(Boolean);
            para([`${LBL.responsible[i.responsible] || ''}${i.responsibleName ? ` (${i.responsibleName})` : ''}`, LBL.frequency[i.frequency], forGoals.length ? `for: ${forGoals.join('; ')}` : null].filter(Boolean).join(' · '),
              { indent: 10, size: 8.5, color: ROI_COLORS.muted });
          }
        }
        const mm = plan.medicationManagement || {};
        if (mm.managedBy || mm.pharmacy || mm.adherenceConcerns) {
          next('Medication management');
          fieldRow([{ label: 'Managed day to day by', value: LBL.managedBy[mm.managedBy] || '' }, { label: 'Pharmacy', value: mm.pharmacy || '' }]);
          if (mm.adherenceConcerns) para(`Adherence concerns: ${mm.adherenceConcerns}`);
        }
        const oc = plan.outsideCare || {};
        if ((oc.externalTeam || []).length || (oc.communityServices || []).length) {
          next('Outside the practice');
          bullets((oc.externalTeam || []).map(t => [[t.name, t.role, t.organization].filter(Boolean).join(', '), t.phone, t.handles].filter(Boolean).join(' · ')));
          bullets((oc.communityServices || []).map(c => `${c.name} (${c.status})${c.notes ? ` · ${c.notes}` : ''}`));
        }
      }

      if ((plan.eachVisit || []).length) {
        next('Task list — each visit');
        bullets(plan.eachVisit);
      }

      next('Visit schedule & duration');
      fieldRow([{ label: 'Frequency', value: plan.visitFrequency }, { label: 'Days', value: (plan.visitDays || []).join(', ') }]);
      fieldRow([{ label: 'Times', value: plan.visitTimes }, { label: 'Duration', value: plan.duration }]);
      fieldRow([{ label: 'Effective date', value: fmt(plan.effectiveDate) }, { label: structured ? 'Next review' : 'Target date', value: fmt(structured ? (plan.review || {}).nextReviewDate : plan.targetDate) }]);
      if (plan.chargePlanNote) {
        doc.fontSize(7).fillColor(ROI_COLORS.muted).font('Helvetica').text('CHARGE PLAN', L, y);
        doc.fontSize(9.5).fillColor(ROI_COLORS.ink).font('Helvetica').text(plan.chargePlanNote, L, y + 10, { width: W });
        y += doc.heightOfString(plan.chargePlanNote, { width: W }) + 20;
      }

      if (structured) {
        const esc = plan.escalation || {};
        next('Safety and escalation');
        if ((esc.callGfcWhen || []).length) { para('Call GFC when:', { font: 'Helvetica-Bold', after: 2 }); bullets(esc.callGfcWhen); }
        if ((esc.call911When || []).length) { para('Call 911 when:', { font: 'Helvetica-Bold', after: 2 }); bullets(esc.call911When); }
        if ((esc.callOrder || []).length) para(`Who to call, in order: ${esc.callOrder.join(' → ')}`);
        if (esc.afterHours) para(`After hours: ${esc.afterHours}`);
        if (esc.hospitalPreference) para(`Hospital preference: ${esc.hospitalPreference}`);
        if (d.codeStatus) para(`Code status (from intake): ${d.codeStatus}`);
        const rv = plan.review || {};
        next('Review');
        fieldRow([{ label: 'Review cadence', value: LBL.cadence[rv.cadence] || '' }, { label: 'Next review', value: fmt(rv.nextReviewDate) }]);
      }

      // ── Signatures — THIS document's signatures, respectively ──
      next('Signatures');
      doc.fontSize(8.5).fillColor(ROI_COLORS.ink).font('Helvetica')
        .text('This care plan was developed with the client and family and is reviewed periodically. It takes effect when signed by the authoring clinician and co-signed by the client or authorized representative.', L, y, { width: W });
      y += doc.heightOfString('This care plan was developed with the client and family and is reviewed periodically. It takes effect when signed by the authoring clinician and co-signed by the client or authorized representative.', { width: W }) + 8;
      signatureBlock('Author signature', d.rnSignature);
      if (providerRequired) {
        // The provider (or LCSW) signature that completes an RN- or
        // LMSW-authored plan, with the credential it was signed under.
        signatureBlock('Clinician co-signature', providerSigned ? d.providerSignature : { pending: true });
        if (providerSigned && (d.providerSignature.clinicalRole || d.providerSignature.npi)) {
          const role = { provider: 'Provider', lcsw: 'LCSW', rn: 'RN', lmsw: 'LMSW', coordinator: 'Care coordinator' }[d.providerSignature.clinicalRole] || d.providerSignature.clinicalRole || '';
          doc.fontSize(8).fillColor(ROI_COLORS.muted).font('Helvetica')
            .text([role && `Signed as ${role}`, d.providerSignature.npi && `NPI ${d.providerSignature.npi}`].filter(Boolean).join(' · '), L, y - 6, { width: W });
          y += 10;
        }
      }
      signatureBlock('Client or authorized representative co-signature',
        d.clientSignature || { pending: true });

      // ── Footer ──
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.fontSize(7.5).fillColor(ROI_COLORS.muted).font('Helvetica-Oblique')
        .text(`${ROI_ORG.name}  ·  Care Plan v${plan.version ?? '—'}  ·  Generated ${today}`, L, Math.min(y + 8, 760), { width: W });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// THE REQUISITION — Session 4.10, Scope A6. One generator, every order type.
// ============================================================================
//
// FAX-SAFE RENDERING, and every rule below is there because faxing destroys
// anything subtle. This document is opened on a phone, handed to Doximity
// through the share sheet, and comes out of a machine in a lab or a supplier's
// back office at 200dpi in one bit per pixel.
//
//   • BLACK ON WHITE. No brand colour carrying meaning — a navy heading faxes
//     to a black heading, so the colour said nothing and cost contrast. No
//     light greys: they drop out entirely, which turns a printed field label
//     into a blank line. No background fills behind text, because a filled
//     panel faxes to a black box with the text gone.
//   • 10pt body minimum, 12pt for the identifiers, so a second-generation fax
//     is still readable.
//   • ONE PAGE is the target. Attachments are what push it longer, and then
//     every page is numbered "Page N of M" — a fax that arrives short has to be
//     detectable as short.
//   • PATIENT NAME, DOB AND MBI ON EVERY PAGE, TOP AND BOTTOM. Fax pages
//     separate, get re-stacked and get re-scanned. A page with no identifiers is
//     a page that ends up in the wrong chart.
//   • THE ORDER REFERENCE, LARGE, ON EVERY PAGE, with the sentence asking for it
//     back. That reference is the whole matching mechanism for an inbound result
//     (Scope C) and it only works if it survives the round trip.
//   • NO COVER SHEET. Doximity supplies one. Two cover sheets is noise, and the
//     second one buries the first.
const REQ = {
  L: 48,                       // left margin
  R: 612 - 48,                 // right edge (LETTER width 612)
  TOP: 34,                     // identifier strip sits above the content
  BODY: 10,                    // minimum body size — never smaller
  ID: 12,                      // identifiers
  ink: '#000000',              // the only ink there is
  rule: '#000000'              // high-contrast rules only
};
REQ.W = REQ.R - REQ.L;

const reqDash = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s || '—';
};

// STAMPED AFTER THE MERGE, WITH pdf-lib, AND THAT IS THE WHOLE POINT.
//
// The first version stamped with pdfkit's buffered pages, which covers the pages
// pdfkit itself wrote and NOTHING ELSE. So a referral with an attached consult
// note produced a two-page fax whose second page carried no patient name, no
// DOB, no MBI and no order reference — exactly the page that ends up in the
// wrong chart — and whose first page still said nothing about pagination, so a
// fax that lost the attachment arrived looking complete. Caught by reading the
// rendered document back, not by reading the code.
//
// Doing it here means there is ONE stamper and it provably reaches every page of
// whatever is actually being sent. Positions come from each page's own box, so an
// attachment on A4 is stamped correctly rather than off the edge.
async function stampRequisitionPages(bytes, ids) {
  const doc = await PDFLib.load(bytes);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  const line = `${reqDash(ids.patientName)}   ·   DOB ${reqDash(ids.dob)}   ·   MBI ${reqDash(ids.mbi)}`;
  const ref = String(ids.reference || '');
  const black = rgb(0, 0, 0);
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    const L = REQ.L;
    const R = width - REQ.L;
    const W = R - L;
    // A blank strip behind the stamp, so an attachment's own header cannot
    // collide with the identifiers. WHITE, never grey — a fill behind text faxes
    // to a black box with the text gone.
    const white = rgb(1, 1, 1);
    page.drawRectangle({ x: 0, y: height - 30, width, height: 30, color: white });
    page.drawRectangle({ x: 0, y: 0, width, height: 54, color: white });

    page.drawText(line, { x: L, y: height - 20, size: REQ.BODY, font: bold, color: black });
    page.drawText(ref, { x: R - bold.widthOfTextAtSize(ref, REQ.ID), y: height - 21, size: REQ.ID, font: bold, color: black });
    page.drawLine({ start: { x: L, y: height - 27 }, end: { x: R, y: height - 27 }, thickness: 1, color: black });

    page.drawLine({ start: { x: L, y: 46 }, end: { x: R, y: 46 }, thickness: 1, color: black });
    page.drawText(line, { x: L, y: 34, size: REQ.BODY, font: bold, color: black });
    page.drawText(ref, { x: R - bold.widthOfTextAtSize(ref, REQ.ID), y: 33, size: REQ.ID, font: bold, color: black });
    const ask = 'Please include this reference when returning results.';
    page.drawText(ask, { x: L, y: 20, size: 9, font: plain, color: black });
    // A SINGLE-PAGE requisition says nothing about pagination; a multi-page one
    // must, or a fax that loses its last page arrives looking complete.
    if (total > 1) {
      const label = `Page ${i + 1} of ${total}`;
      page.drawText(label, { x: R - bold.widthOfTextAtSize(label, 9), y: 20, size: 9, font: bold, color: black });
    }
    void W;
  });
  return Buffer.from(await doc.save());
}

/**
 * generateRequisitionPDF — the fax-ready document for one order.
 *
 * REFUSES rather than renders when the ordering clinician has no NPI on file: a
 * requisition with no signature is a document a lab cannot act on and a
 * supplier cannot bill against, and handing one over reads as complete.
 *
 * @param {object} d
 *   order, client, orderingClinician, requisitionSettings { returnFax, returnFaxFormatted, returnFaxLabel, requisitionPhone },
 *   standingOrder (optional), attachments (optional array of PDF Buffers)
 */
async function generateRequisitionPDF(d) {
  const order = (d && d.order) || {};
  const client = (d && d.client) || {};
  const clinician = (d && d.orderingClinician) || order.orderingClinician || {};
  const settings = (d && d.requisitionSettings) || {};
  const intake = client.intake || {};
  const orderType = String(order.orderType || 'lab');

  if (!clinician.npi) {
    const err = new Error(`${clinician.name || 'The ordering clinician'} has no NPI on file, so this requisition cannot carry an electronic signature. An admin records the NPI on the user record.`);
    err.code = 'REQUISITION_NO_NPI';
    throw err;
  }

  const patientName = client.name || [intake.firstName, intake.lastName].filter(Boolean).join(' ') || 'Unknown patient';
  const dob = intake.dob || client.dob || '';
  const mbi = (order.dme && order.dme.mbi) || client.mbi || intake.mbi || ((client.payer || {}).memberId) || '';
  const reference = order.orderReference || '(no reference)';

  const base = await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        // Margins leave room for the identifier strips top and bottom.
        margins: { top: REQ.TOP + 14, bottom: 62, left: REQ.L, right: REQ.L },
        bufferPages: true
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let y = REQ.TOP + 14;
      const room = (need) => {
        if (y + (need || 16) > doc.page.height - 74) { doc.addPage(); y = REQ.TOP + 14; }
      };
      const heading = (text) => {
        room(26);
        doc.font('Helvetica-Bold').fontSize(11).fillColor(REQ.ink)
          .text(String(text).toUpperCase(), REQ.L, y, { width: REQ.W, characterSpacing: 0.5 });
        y += 11;
        doc.moveTo(REQ.L, y).lineTo(REQ.R, y).lineWidth(0.9).strokeColor(REQ.rule).stroke();
        y += 5;
      };
      // A labelled value. The LABEL is small and bold rather than grey, because
      // grey does not survive a fax; the VALUE is 12pt where it is an identifier.
      const pair = (label, value, opts) => {
        const o = opts || {};
        const w = o.width || REQ.W;
        const size = o.id ? REQ.ID : REQ.BODY;
        const text = reqDash(value);
        const h = doc.font('Helvetica').fontSize(size).heightOfString(text, { width: w });
        // `noRoom` is how the two-column helper stays correct. Letting the FIRST
        // column trigger a page break and then restoring `y` for the second one
        // draws the second column onto the NEW page at the OLD y — off the
        // bottom — and every later room() check then adds another page. That is
        // what produced a four-page DME order with three near-empty pages;
        // caught by reading the rendered document back, not by reading the code.
        if (!o.noRoom) room(h + 14);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(REQ.ink)
          .text(String(label).toUpperCase(), o.x == null ? REQ.L : o.x, y, { width: w, characterSpacing: 0.4 });
        doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
          .text(text, o.x == null ? REQ.L : o.x, y + 9, { width: w });
        if (o.inline) return h + 9;
        y += h + 12;
        return h + 12;
      };
      const twoUp = (a, b) => {
        const colW = (REQ.W - 18) / 2;
        // Measure BOTH columns, make room for the taller, and only then draw —
        // so neither column can move the page under the other.
        const ha = doc.font('Helvetica').fontSize(a.id ? REQ.ID : REQ.BODY).heightOfString(reqDash(a.value), { width: colW });
        const hb = doc.font('Helvetica').fontSize(b.id ? REQ.ID : REQ.BODY).heightOfString(reqDash(b.value), { width: colW });
        room(Math.max(ha, hb) + 12);
        const startY = y;
        pair(a.label, a.value, { x: REQ.L, width: colW, inline: true, noRoom: true, id: a.id, bold: a.bold });
        y = startY;
        pair(b.label, b.value, { x: REQ.L + colW + 18, width: colW, inline: true, noRoom: true, id: b.id, bold: b.bold });
        y = startY + Math.max(ha, hb) + 12;
      };
      const para = (text, opts) => {
        const o = opts || {};
        const t = String(text || '').trim();
        if (!t) return;
        const h = doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || REQ.BODY).heightOfString(t, { width: REQ.W });
        room(h + 6);
        doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || REQ.BODY).fillColor(REQ.ink)
          .text(t, REQ.L, y, { width: REQ.W });
        y += h + (o.gap == null ? 6 : o.gap);
      };

      // ── Title ─────────────────────────────────────────────────────────
      const TITLES = {
        lab: 'Laboratory Requisition',
        imaging: 'Imaging Requisition',
        procedure: 'Procedure Order',
        referral: 'Referral',
        dme: 'Standard Written Order — Durable Medical Equipment'
      };
      doc.font('Helvetica-Bold').fontSize(16).fillColor(REQ.ink)
        .text(TITLES[orderType] || 'Clinical Order', REQ.L, y, { width: REQ.W });
      y += 21;
      doc.font('Helvetica-Bold').fontSize(REQ.BODY)
        .text(consentText.ORG.name, REQ.L, y, { width: REQ.W });
      y += 12;
      doc.font('Helvetica').fontSize(9)
        .text(`${consentText.ORG.address}   ·   Tel ${settings.requisitionPhone || consentText.ORG.phone}`, REQ.L, y, { width: REQ.W });
      y += 16;
      doc.moveTo(REQ.L, y).lineTo(REQ.R, y).lineWidth(1.6).strokeColor(REQ.rule).stroke();
      y += 10;

      // ── WRITTEN ORDER PRIOR TO DELIVERY ───────────────────────────────
      // Printed prominently because the SUPPLIER MAY NOT DELIVER before they
      // hold it — power mobility devices are the statutory case. An outlined
      // box, never a filled one: a filled panel faxes to a black rectangle.
      if (orderType === 'dme' && order.dme && order.dme.requiresWOPD) {
        room(30);
        doc.rect(REQ.L, y, REQ.W, 23).lineWidth(1.6).strokeColor(REQ.rule).stroke();
        doc.font('Helvetica-Bold').fontSize(13).fillColor(REQ.ink)
          .text('WRITTEN ORDER PRIOR TO DELIVERY', REQ.L, y + 6, { width: REQ.W, align: 'center' });
        y += 29;
      }
      // Priority, printed LARGE when it is urgent or stat. A routine order says
      // routine in the body; an urgent one has to be readable across a desk.
      const urgency = String((order.referral && order.referral.urgency) || order.priority || 'routine');
      if (urgency === 'urgent' || urgency === 'stat') {
        room(28);
        doc.rect(REQ.L, y, REQ.W, 22).lineWidth(1.6).strokeColor(REQ.rule).stroke();
        doc.font('Helvetica-Bold').fontSize(14).fillColor(REQ.ink)
          .text(urgency.toUpperCase(), REQ.L, y + 5, { width: REQ.W, align: 'center' });
        y += 28;
      }

      // ── Patient ───────────────────────────────────────────────────────
      heading('Patient');
      twoUp({ label: 'Name', value: patientName, id: true, bold: true }, { label: 'Date of birth', value: dob, id: true });
      const addr = client.address || intake.address || {};
      const addrLine = [addr.line1 || addr.street, addr.line2, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip || addr.postalCode]
        .filter(Boolean).join(' ');
      twoUp({ label: 'Sex', value: intake.gender || client.gender }, { label: 'Phone', value: client.phone || intake.phone });
      pair('Address', addrLine);
      // B1: read through the ONE payer vocabulary. `primaryName` was never
      // written by anything, so this line printed blank on every requisition.
      const payers = insuranceEligibility.normalizePayers(client);
      const p1 = payers.primary || payers.entries[0] || null;
      const p2 = payers.secondary || null;
      twoUp({ label: 'MBI / Medicare id', value: mbi, id: true }, { label: 'Primary payer', value: p1 ? [p1.payerName, p1.memberId].filter(Boolean).join(' — ') : '' });
      if (p2) {
        pair('Secondary payer', [p2.payerName, p2.memberId].filter(Boolean).join(' — '));
      }

      // ── Diagnoses ─────────────────────────────────────────────────────
      heading('Diagnoses (ICD-10-CM)');
      const dxRows = (d.diagnoses && d.diagnoses.length ? d.diagnoses : (order.diagnosisCodes || []).map(c => ({ code: c, description: '' })));
      if (!dxRows.length) para('—');
      for (const dx of dxRows) {
        const line = `${dx.code}${dx.description ? `   ${dx.description}` : ''}`;
        const h = doc.font('Helvetica').fontSize(REQ.BODY).heightOfString(line, { width: REQ.W - 14 });
        room(h + 5);
        doc.font('Helvetica-Bold').fontSize(REQ.BODY).fillColor(REQ.ink).text('•', REQ.L, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(REQ.BODY).text(line, REQ.L + 12, y, { width: REQ.W - 14 });
        y += h + 4;
      }
      y += 4;

      // ── The order itself, per type ────────────────────────────────────
      if (orderType === 'referral') {
        const r = order.referral || {};
        heading('Referral to');
        twoUp({ label: 'Specialty', value: r.specialty, bold: true }, { label: 'Practice / provider', value: [r.receivingPractice, r.receivingProvider].filter(Boolean).join(' — ') });
        twoUp({ label: 'Fax', value: reqFmtFax(r.receivingFax), id: true }, { label: 'Phone', value: r.receivingPhone });
        pair('Urgency', (r.urgency || 'routine').toUpperCase());
        if (r.priorAuthRequired) {
          pair('Prior authorization', r.priorAuthNumber
            ? `REQUIRED — authorization ${r.priorAuthNumber}`
            : 'REQUIRED — authorization number not yet obtained', { bold: true });
        }
        heading('Reason for referral');
        para(r.reason);
        heading('Clinical summary and the question asked');
        para(r.clinicalSummary);
      } else if (orderType === 'dme') {
        const m = order.dme || {};
        heading('Item ordered');
        pair('Item', [m.itemDescription, m.hcpcsCode ? `(HCPCS ${m.hcpcsCode})` : null].filter(Boolean).join(' '), { id: true, bold: true });
        twoUp({ label: 'Quantity to be dispensed', value: String(m.quantity), id: true }, { label: 'Length of need', value: m.lengthOfNeed, id: true });
        twoUp({ label: 'Order date', value: m.orderDate, id: true }, { label: 'Beneficiary', value: [m.beneficiaryName, m.mbi ? `MBI ${m.mbi}` : null].filter(Boolean).join(' · ') });
        heading('Supplier');
        twoUp({ label: 'Supplier', value: m.supplierName, bold: true }, { label: 'Supplier fax', value: reqFmtFax(m.supplierFax), id: true });
        if (m.supplierPhone) pair('Supplier phone', m.supplierPhone);
        if (m.requiresF2F) {
          heading('Face-to-face encounter');
          pair('Encounter date', m.faceToFaceDate, { id: true });
          para('This item requires a face-to-face encounter. The encounter above is within the six months before the order date and is documented in the patient\'s record.');
        }
      } else {
        heading(orderType === 'imaging' ? 'Studies requested' : orderType === 'procedure' ? 'Procedure requested' : 'Tests requested');
        const tests = order.tests || [];
        if (!tests.length) para('—');
        for (const t of tests) {
          const label = typeof t === 'string' ? t : (t && (t.name || t.description)) || '';
          const h = doc.font('Helvetica').fontSize(REQ.ID).heightOfString(label, { width: REQ.W - 14 });
          room(h + 5);
          doc.font('Helvetica-Bold').fontSize(REQ.ID).fillColor(REQ.ink).text('•', REQ.L, y, { lineBreak: false });
          doc.font('Helvetica').fontSize(REQ.ID).text(label, REQ.L + 14, y, { width: REQ.W - 14 });
          y += h + 4;
        }
        y += 4;
        pair('Priority', urgency.toUpperCase());
      }

      if (order.notes) { heading('Notes'); para(order.notes); }

      // ── Ordering clinician and the signature ──────────────────────────
      heading('Ordering clinician');
      twoUp(
        { label: 'Name and credential', value: [clinician.name, clinician.licenseLevel].filter(Boolean).join(', '), id: true, bold: true },
        { label: 'NPI', value: clinician.npi, id: true }
      );
      // UNDER A STANDING ORDER THE AUTHORIZING PROVIDER IS THE ORDERING
      // CLINICIAN, and the document says so plainly — the person who carried it
      // out is named too, because a requisition that hides the execution is a
      // requisition nobody can reconstruct.
      if (d.standingOrder) {
        const so = d.standingOrder;
        para(`Executed under standing order "${so.title}" v${so.version} by ${[(order.executedBy || {}).name, (order.executedBy || {}).credential].filter(Boolean).join(', ') || 'a member of the clinical team'}.`);
      }
      // THE ELECTRONIC SIGNATURE. For a DME order this satisfies SWO element 6 —
      // the treating practitioner's signature — and the wording is the standard
      // attestation form rather than a picture of a signature, which would not
      // survive a fax legibly anyway.
      const signedAt = gfcTime.fmtDateTime(d.generatedAt || new Date().toISOString());
      room(34);
      doc.rect(REQ.L, y, REQ.W, 26).lineWidth(1.2).strokeColor(REQ.rule).stroke();
      doc.font('Helvetica-Bold').fontSize(REQ.BODY).fillColor(REQ.ink)
        .text(`Electronically signed by ${[clinician.name, clinician.licenseLevel].filter(Boolean).join(', ')}, NPI ${clinician.npi}, on ${signedAt} ET.`,
          REQ.L + 8, y + 7, { width: REQ.W - 16 });
      y += 32;

      // ── Where the answer goes ─────────────────────────────────────────
      heading('Return results to');
      pair(settings.returnFaxLabel || consentText.ORG.name, settings.returnFaxFormatted
        ? `Fax ${settings.returnFaxFormatted}`
        : 'Fax number not configured — call the number below', { id: true, bold: true });
      twoUp(
        { label: 'Telephone', value: settings.requisitionPhone || consentText.ORG.phone, id: true },
        { label: 'Attention', value: [clinician.name, clinician.licenseLevel].filter(Boolean).join(', ') }
      );
      para(`Generated ${signedAt} ET. Please include ${reference} on every page returned.`, { size: 9, gap: 0 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

  // ── Attachments ────────────────────────────────────────────────────────
  // Appended AFTER the letter, in the order they were selected. mergePDFBuffers
  // already exists for the service-report path; a buffer it cannot parse is
  // SKIPPED rather than failing the whole requisition — losing an attachment is
  // recoverable, losing the order is a visit that does not happen.
  const attachments = (d.attachments || []).filter(Buffer.isBuffer);
  let merged = base;
  if (attachments.length) {
    // A buffer pdf-lib cannot parse is SKIPPED rather than failing the whole
    // requisition: losing an attachment is recoverable, losing the order is a
    // visit that does not happen.
    try { merged = await mergePDFBuffers([base, ...attachments]); }
    catch { merged = base; }
  }
  return stampRequisitionPages(merged, { patientName, dob, mbi, reference });
}

// ============================================================
// The signed clinical note (owner, 2026-09-27)
// ============================================================
// OpenEMR's note field is plain text, so bold, italic and underline cannot
// live there. This is the copy that looks exactly like what was signed, filed
// to the patient's OpenEMR Documents at signing and again on each clinician
// addendum or co-signature. The signature block is BOLD and set apart, which
// is the one thing the owner asked the final signature to be.
//
// The caller hands over the note already laid out (clinicalNotes
// .noteReadingOrder) and the signature summary, so the PDF and the OpenEMR
// text are built from ONE ordering and cannot disagree about the note.
const noteFormat = require('./public/note-format');
const NOTE_SLOT_LABELS = { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' };

async function generateSignedNotePDF(d) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const L = 48, R = 612 - 48, W = R - L, BOTTOM = 730;
      const C = ROI_COLORS;
      const et = (iso) => (iso ? `${gfcTime.fmtDateTime(iso)} ET` : '—');
      let y = 44;
      const room = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 48; } };

      // Header — who and which visit, on the first page.
      // The practice's own logo (white lockup, trimmed to its artwork) sits at
      // the right of the bar; the title stays at the left.
      const HEADER_H = 40, LOGO_H = 26, LOGO_W = Math.round(LOGO_H * 1021 / 334);
      doc.rect(L, y, W, HEADER_H).fill(C.navy);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14).text('Clinical Note', L + 12, y + 13);
      doc.image(path.join(__dirname, 'public', 'brand', 'logo-full-white-trimmed.png'),
        R - 12 - LOGO_W, y + (HEADER_H - LOGO_H) / 2, { width: LOGO_W, height: LOGO_H });
      y += HEADER_H + 10;
      const meta = [
        ['Patient', d.patientName], ['Date of birth', d.dob], ['Visit date', d.visitDate],
        ['Visit', d.visitLabel], ['Encounter', d.encounterId]
      ].filter(([, v]) => v);
      doc.fontSize(9).fillColor(C.ink);
      for (const [label, value] of meta) {
        doc.font('Helvetica-Bold').text(`${label}: `, L, y, { continued: true }).font('Helvetica').text(String(value));
        y = doc.y + 2;
      }
      y += 6;

      const fontFor = (r) => (r.b && r.i ? 'Helvetica-BoldOblique' : r.b ? 'Helvetica-Bold' : r.i ? 'Helvetica-Oblique' : 'Helvetica');
      // One block of formatted markup: headings, bullets, numbers, and runs of
      // bold / italic / underline — the same six shapes the editor produces.
      const drawMarkup = (markup, indent = 0) => {
        for (const bl of noteFormat.toBlocks(markup)) {
          if (bl.type === 'blank') { y += 5; continue; }
          const size = bl.type === 'h' ? 10.5 : 9.5;
          const prefix = bl.type === 'ul' ? '•  ' : bl.type === 'ol' ? `${bl.n}.  ` : '';
          const x = L + indent + (prefix ? 10 : 0);
          const runs = bl.runs.length ? bl.runs : [{ text: ' ' }];
          const text = runs.map(r => r.text).join('');
          room(doc.font('Helvetica').fontSize(size).heightOfString(prefix + text, { width: W - indent - 10 }) + 4);
          doc.fillColor(C.ink).fontSize(size);
          if (prefix) doc.font('Helvetica').text(prefix, L + indent, y, { continued: false, lineBreak: false });
          runs.forEach((r, i) => {
            const last = i === runs.length - 1;
            const opts = { continued: !last, underline: !!r.u, width: W - indent - (prefix ? 10 : 0) };
            doc.font(bl.type === 'h' ? 'Helvetica-Bold' : fontFor(r));
            if (i === 0) doc.text(r.text, x, y, opts); else doc.text(r.text, opts);
          });
          y = doc.y + 3;
        }
      };
      const drawPlain = (text, indent = 0) => {
        const t = String(text || '');
        room(doc.font('Helvetica').fontSize(9.5).heightOfString(t, { width: W - indent }) + 4);
        doc.fillColor(C.ink).font('Helvetica').fontSize(9.5).text(t, L + indent, y, { width: W - indent });
        y = doc.y + 3;
      };

      if (d.voided) {
        drawPlain(`This draft was discarded by ${d.voided.by && d.voided.by.name ? d.voided.by.name : 'a clinician'} on ${et(d.voided.at)}: ${d.voided.reason}`);
      }
      let slot = null;
      for (const item of (d.items || [])) {
        if (item.slot !== slot) {
          slot = item.slot;
          room(28);
          y += 4;
          doc.rect(L, y, W, 16).fill(C.cream);
          doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(9)
            .text(NOTE_SLOT_LABELS[slot].toUpperCase(), L + 8, y + 4, { characterSpacing: 0.6 });
          y += 22;
        }
        if (item.label) {
          room(14);
          doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(9).text(item.label, L, y);
          y = doc.y + 2;
        }
        if (item.markup !== undefined) drawMarkup(item.markup, item.label ? 6 : 0);
        else drawPlain(item.plain, item.label ? 6 : 0);
        y += 4;
      }

      // Addenda — each with its own signer and time.
      const addenda = Array.isArray(d.addenda) ? d.addenda : [];
      if (addenda.length) {
        room(28); y += 6;
        doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10).text('Addenda', L, y); y = doc.y + 4;
        for (const a of addenda) {
          room(30);
          const who = a.by ? `${a.by.name || 'Unknown'}${a.by.licenseLevel ? `, ${a.by.licenseLevel}` : ''}` : 'Unknown';
          doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9)
            .text(`${a.kind === 'clinician_addendum' ? 'Clinician addendum' : 'Addendum'} — ${who} — ${et(a.at)}`, L, y);
          y = doc.y + 2;
          drawMarkup(a.text, 6);
          y += 4;
        }
      }

      // Note history — every saved draft, its editor and its time.
      const history = Array.isArray(d.history) ? d.history : [];
      if (history.length) {
        room(24); y += 6;
        doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('NOTE HISTORY — every saved draft', L, y, { characterSpacing: 0.5 });
        y = doc.y + 2;
        for (const line of history) { room(11); doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(line, L, y); y = doc.y + 1; }
      }

      // The signature block — bold, ruled, set apart. The final signature is
      // the one thing on this page that has to be unmistakable.
      const sig = d.signature;
      if (sig) {
        const lines = [];
        lines.push(sig.signer.capacity === 'author'
          ? `Signed by ${d.person(sig.signer)} — author (not a billing signature) — ${et(sig.signer.at)}`
          : `Signed by ${d.person(sig.signer)} — ${et(sig.signer.at)}`);
        if (sig.billing) lines.push(`Clinician addendum and billing signature: ${d.person(sig.billing)} — ${et(sig.billing.at)}`);
        if (sig.awaitingAddendum) lines.push('Awaiting clinician addendum — not billable until a provider (or an LCSW, for behavioral health) adds it.');
        for (const c of sig.coSignatures || []) lines.push(`Co-signed by ${d.person(c)} — ${et(c.at)}`);
        const h = 26 + lines.reduce((s, l) => s + doc.font('Helvetica-Bold').fontSize(10).heightOfString(l, { width: W - 20 }) + 4, 0);
        room(h + 10);
        y += 10;
        doc.rect(L, y, W, h).lineWidth(1.4).strokeColor(C.navy).stroke();
        doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(11).text('ELECTRONICALLY SIGNED', L + 10, y + 8);
        let ly = y + 26;
        for (const l of lines) {
          doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(l, L + 10, ly, { width: W - 20 });
          ly = doc.y + 4;
        }
        y += h + 6;
      }

      // Footer on every page: who, which note, page n of m.
      // Written below the bottom margin, so the margin is lifted for the
      // footer alone — otherwise pdfkit treats it as overflow and adds a blank
      // page to hold it.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.fillColor(C.muted).font('Helvetica').fontSize(7.5)
          .text(`${d.patientName || ''}${d.dob ? ` · DOB ${d.dob}` : ''} · Encounter ${d.encounterId || ''} · page ${i + 1} of ${range.count}`,
            L, 758, { width: W, align: 'center', lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── After-visit summary (owner, 2026-09-29) ─────────────────────────────────
// The paper copy of what the patient portal shows: something to leave with the
// patient, hand to a family member or send to a facility for the resident's
// chart. It is rendered from ONE assembled document (afterVisitSummary.js), so
// the portal, the staff download and the patient download cannot disagree.
// Larger type than the clinical note (older readers) and no clinical codes.
async function generateAfterVisitSummaryPDF(d) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const L = 48, R = 612 - 48, W = R - L, BOTTOM = 728;
      const C = ROI_COLORS;
      let y = 44;
      const room = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 48; } };
      const BODY = 11, HEAD = 12.5;

      // Header bar: title left, the practice's logo right (same as the note PDF).
      const HEADER_H = 44, LOGO_H = 28, LOGO_W = Math.round(LOGO_H * 1021 / 334);
      doc.rect(L, y, W, HEADER_H).fill(C.navy);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('Visit Summary', L + 12, y + 14);
      doc.image(path.join(__dirname, 'public', 'brand', 'logo-full-white-trimmed.png'),
        R - 12 - LOGO_W, y + (HEADER_H - LOGO_H) / 2, { width: LOGO_W, height: LOGO_H });
      y += HEADER_H + 12;

      // Who and which visit.
      const meta = [
        ['Patient', d.patientName], ['Date of birth', d.dob], ['Visit date', d.visitDateLabel],
        ['Seen by', d.providerLabel], ['Visit', d.visitReason]
      ].filter(([, v]) => v);
      doc.fontSize(BODY);
      for (const [k, v] of meta) {
        const h = doc.heightOfString(String(v), { width: W - 110 });
        room(h + 4);
        doc.fillColor(C.muted).font('Helvetica').text(k, L, y, { width: 100 });
        doc.fillColor(C.ink).font('Helvetica-Bold').text(String(v), L + 110, y, { width: W - 110 });
        y += h + 4;
      }
      y += 6;

      const heading = (t) => {
        y += 8;
        room(40);
        doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(HEAD).text(t, L, y, { width: W });
        y += 17;
        doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(C.goldRule).stroke();
        y += 6;
        doc.fontSize(BODY).fillColor(C.ink).font('Helvetica');
      };
      // Free text keeps its line breaks ("1. … 2. …" stays a list).
      const paragraph = (t) => {
        for (const line of String(t).split('\n')) {
          const h = doc.heightOfString(line || ' ', { width: W });
          room(h + 3);
          doc.fillColor(C.ink).font('Helvetica').fontSize(BODY).text(line || ' ', L, y, { width: W, lineGap: 1.5 });
          y = Math.max(y + h, doc.y) + 3;
        }
        y += 6;
      };
      // A row is a string or { tag?, text, detail? }: an optional bold tag
      // ("NEW"), the bold item, then plain detail after a dash.
      const bullets = (rows) => {
        for (const r of rows) {
          const it = typeof r === 'string' ? { text: r } : r;
          const full = `${it.tag ? `${it.tag}  ` : ''}${it.text}${it.detail ? ` — ${it.detail}` : ''}`;
          // Measured in bold (the wider face) so a wrapped row reserves enough room.
          const h = doc.font('Helvetica-Bold').fontSize(BODY).heightOfString(full, { width: W - 16 });
          room(h + 4);
          doc.fillColor(C.ink).font('Helvetica').fontSize(BODY).text('•', L + 2, y, { width: 10, lineBreak: false });
          let cont = true;
          const parts = [];
          if (it.tag) parts.push([`${it.tag}  `, 'Helvetica-Bold', C.navy]);
          parts.push([it.text, 'Helvetica-Bold', C.ink]);
          if (it.detail) parts.push([` — ${it.detail}`, 'Helvetica', C.ink]);
          // A row that fits on one line is set part by part at measured x
          // positions; pdfkit's `continued` runs can break a short row early.
          const widths = parts.map(([t, f]) => doc.font(f).fontSize(BODY).widthOfString(t));
          if (widths.reduce((a, b) => a + b, 0) <= W - 16) {
            let x = L + 14;
            parts.forEach(([t, f, col], i) => { doc.fillColor(col).font(f).text(t, x, y, { lineBreak: false }); x += widths[i]; });
            doc.y = y + h;
          } else {
            parts.forEach(([t, f, col], i) => {
              doc.fillColor(col).font(f).text(t, i === 0 ? L + 14 : undefined, i === 0 ? y : undefined, { width: W - 16, continued: i < parts.length - 1 });
            });
          }
          // Where pdfkit actually finished, never less than the measured height:
          // mixed bold/regular runs can wrap onto a line the estimate missed.
          y = Math.max(y + h, doc.y) + 4;
        }
        y += 6;
      };

      heading('What we did today');
      paragraph(d.whatWeDid || 'Your clinician will go over this visit with you.');
      if ((d.diagnoses || []).length) {
        doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(BODY).text('This visit covered:', L, y, { width: W });
        y += 15;
        bullets(d.diagnoses);
      }

      heading('Your medications');
      const meds = d.medications || {};
      if (meds.available === false) {
        paragraph('Your medication list was not available for this summary. Please ask your care team for your current list.');
      } else {
        if ((meds.changes || []).length) {
          doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(BODY).text('Changes at this visit:', L, y, { width: W });
          y += 15;
          bullets(meds.changes);
        } else {
          paragraph('No medication changes were recorded at this visit.');
        }
        if ((meds.current || []).length) {
          doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(BODY).text('Your current medications:', L, y, { width: W });
          y += 15;
          bullets(meds.current);
        } else if (meds.noneOnFile) {
          paragraph('No current medications are on your list. If you take any medicine, vitamin or supplement, please tell your care team.');
        } else if (!meds.hiddenCurrent) {
          paragraph('Your full medication list was not available for this summary. Please ask your care team for your current list.');
        }
      }

      // `undefined` = this reader may not see allergies (family sharing), so the
      // section is left out; `null` = the list could not be read, which is
      // never printed as "no allergies".
      if (d.allergies !== undefined) {
        heading('Allergies');
        if (d.allergies == null) paragraph('Your allergy list was not available for this summary. Please ask your care team.');
        else if (!d.allergies.length) paragraph('No allergies are recorded in your chart.');
        else bullets(d.allergies);
      }

      heading('Tests, referrals and equipment ordered');
      if ((d.orders || []).length) bullets(d.orders);
      else paragraph('Nothing was ordered at this visit.');

      heading('Follow-up instructions');
      paragraph(d.followUp || 'No special instructions were written for this visit. Call us if you have any questions.');

      heading('Your next visit');
      if (d.nextVisit && d.nextVisit.when) {
        paragraph([d.nextVisit.when, d.nextVisit.who, d.nextVisit.where,
          `As of ${d.nextVisitAsOf || 'when this summary was prepared'}. Call us to confirm or change it.`].filter(Boolean).join('\n'));
      } else {
        paragraph('Your next visit has not been scheduled yet. We will contact you, or call us to set it up.');
      }

      // Contact and the 911 box are kept together on one page.
      room(150);
      heading('Questions or a new problem');
      paragraph(d.contactLines.join('\n'));
      const boxH = 10 + 16 + doc.heightOfString(d.emergencyText, { width: W - 24 }) + 10;
      room(boxH + 6);
      doc.lineWidth(1.5).strokeColor(C.ink).rect(L, y, W, boxH).stroke();
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(HEAD).text('When to call 911', L + 12, y + 8, { width: W - 24 });
      doc.font('Helvetica').fontSize(BODY).text(d.emergencyText, L + 12, y + 8 + 17, { width: W - 24 });
      y += boxH + 6;

      // Footer on every page. Written below the bottom margin, so the margin is
      // lifted for the footer alone — otherwise pdfkit adds a blank page for it.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.fillColor(C.muted).font('Helvetica').fontSize(8)
          .text(`${d.patientName || ''}${d.dob ? ` · DOB ${d.dob}` : ''} · Visit ${d.visitDateLabel || ''} · Prepared ${d.preparedLabel || ''} · page ${i + 1} of ${range.count}`,
            L, 752, { width: W, align: 'center', lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// A message note (owner, 2026-10-19): one patient-facing conversation on one
// day, filed to OpenEMR so the chart holds what was said. `d.text` is
// chartCommunications.messageNoteText; the first line is its heading.
async function generateMessageNotePDF(d) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const lines = String((d && d.text) || '').split('\n');
  const heading = lines.shift() || 'MESSAGE NOTE';
  let y = faceSheetHeader(doc, heading.charAt(0) + heading.slice(1).toLowerCase(), (d && d.clientName) || '');
  doc.font('Helvetica').fontSize(9.5).fillColor(GFC_COLORS.ink);
  for (const line of lines) {
    if (y > doc.page.height - 70) { doc.addPage(); y = 50; }
    doc.text(line || ' ', 50, y, { width: 512 });
    y = doc.y + 2;
  }
  doc.end();
  return done;
}

// ---- Private Home Care invoice (owner's sample, 2026-11-08) -----------------
// One page in the layout of the owner's LTC carrier invoices: cream header
// band with the logo and INVOICE, FROM / BILL TO, SERVICE DETAILS, the navy
// line table, totals, PAYMENT and the footer. Every number on it is already
// worked out (phcInvoices.js): this only draws. The FROM block is the app's
// one ORG block, never typed again.
async function generatePhcInvoicePDF(inv) {
  return new Promise((resolve, reject) => {
    try {
      const ORG = consentText.ORG;
      const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const NAVY = '#033D50', GOLD = '#C9A44A', CREAM = '#FAF7F2', INK = '#1a1a1a', MUTED = '#777777', RULE = '#BBBBBB';
      const L = 48, R = 612 - 48, W = R - L, MID = 312, BOTTOM = 715;
      const usd = (c) => `$${(Number(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
      let y = 0;
      const room = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 48; } };

      // Header band
      doc.rect(0, 0, 612, 100).fill(CREAM);
      doc.image(path.join(__dirname, 'public', 'brand', 'logo-full-color-transparent.png'), L, 20, { width: 168, height: 58 });
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22).text('INVOICE', MID, 20, { width: R - MID, align: 'right' });
      const meta = [['Invoice #', inv.displayNumber], ['Invoice date', inv.invoiceDate],
        inv.serviceDateLabel ? ['Service date', inv.serviceDateLabel] : ['Service period', inv.periodLabel]].filter(([, v]) => v);
      let my = 47;
      for (const [k, v] of meta) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(`${k}  ${v}`, MID, my, { width: R - MID, align: 'right' });
        my += 11;
      }
      y = 122;

      const sectionHead = (label, x, w, rule) => {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(label, x, y, { characterSpacing: 0.3 });
        doc.moveTo(x, y + 11).lineTo(x + w, y + 11).lineWidth(0.7).strokeColor(rule || RULE).stroke();
      };

      // FROM / BILL TO
      sectionHead('FROM', L, MID - L - 30);
      sectionHead('BILL TO', MID, R - MID);
      const col = (x, w, lines) => {
        let yy = y + 19;
        lines.forEach(([t, bold], i) => {
          if (t === '') { yy += 7; return; }
          doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 0 ? 8.8 : 8.3).text(t, x, yy, { width: w });
          yy = doc.y + 2.5;
        });
        return yy;
      };
      // "4300 Paces Ferry Rd SE, Suite 500, Atlanta, GA 30339" -> street line, city line
      const parts = String(ORG.address).split(/,\s*/);
      const streetLine = parts.slice(0, Math.max(1, parts.length - 2)).join(', ');
      const cityLine = parts.slice(Math.max(1, parts.length - 2)).join(', ');
      const fromLines = [[ORG.name, true], [streetLine], [cityLine], [`Tel ${ORG.phone}  ·  Fax ${ORG.fax}`], [ORG.email]];
      const b = inv.billTo || {};
      const billLines = [[b.name || '', true], b.attn ? [`Attn: ${b.attn}`] : null, ...(b.addressLines || []).map(l => [l]), b.email ? [b.email] : null]
        .filter(Boolean);
      if (b.type === 'carrier') {
        billLines.push(['']);
        billLines.push([`Insured: ${b.insuredName}`]);
        billLines.push([`Policy #: ${b.policyNumber}`]);
        if (b.claimNumber) billLines.push([`Claim #: ${b.claimNumber}`]);
      }
      y = Math.max(col(L, MID - L - 30, fromLines), col(MID, R - MID, billLines)) + 16;

      // SERVICE DETAILS: one block per shift on a carrier invoice. A family
      // invoice covers a period, so its line table carries the shifts.
      sectionHead('SERVICE DETAILS', L, W, GOLD);
      y += 19;
      const detail = (k, v) => {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(k, L, y, { width: 115 });
        doc.fillColor(INK).font('Helvetica').fontSize(8.3).text(String(v), L + 118, y, { width: W - 118 });
        y = Math.max(doc.y, y + 10) + 3.5;
      };
      if (inv.format === 'carrier') {
        (inv.shifts || []).forEach((s, i) => {
          room(100);
          if (i > 0) { y += 6; doc.moveTo(L, y - 4).lineTo(L + 220, y - 4).lineWidth(0.4).strokeColor(RULE).stroke(); }
          if (i === 0) detail('Client', inv.clientName);
          detail('Caregiver', `${s.caregiverName}${s.levelLabel ? `, ${s.levelLabel}` : ''}`);
          detail('Service', s.service);
          detail('Date of service', s.date);
          detail('Shift start (ET)', s.start);
          detail('Shift end (ET)', s.end);
          detail('Billed duration', s.duration);
        });
      } else {
        detail('Client', inv.clientName);
        detail('Service', [...new Set((inv.shifts || []).map(s => s.service))].join('; ') || 'Private home care services');
        detail('Service period', inv.periodLabel);
        detail('Visits', String((inv.shifts || []).length));
        detail('Billed duration', inv.billedDuration);
      }
      y += 14;

      // Line table
      const cHours = R - 190, cRate = R - 120, cAmt = R - 70;
      const header = () => {
        doc.rect(L, y, W, 20).fill(NAVY);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.8);
        doc.text('DESCRIPTION', L + 8, y + 6.5);
        doc.text('HOURS', cHours - 30, y + 6.5, { width: 60, align: 'right' });
        doc.text('RATE', cRate - 20, y + 6.5, { width: 70, align: 'right' });
        doc.text('AMOUNT', cAmt - 10, y + 6.5, { width: 72, align: 'right' });
        y += 20;
      };
      room(48);
      header();
      // A family invoice lists two weeks of shifts, so its rows are tighter.
      const rowMin = inv.format === 'family' ? 17 : 24, pad = inv.format === 'family' ? 4.5 : 8;
      for (const l of inv.lines || []) {
        const h = Math.max(rowMin, doc.font('Helvetica').fontSize(8.3).heightOfString(l.description, { width: cHours - 40 - L }) + pad * 2 - 2);
        if (y + h > BOTTOM) { doc.addPage(); y = 48; header(); }
        doc.fillColor(INK).font('Helvetica').fontSize(8.3).text(l.description, L + 8, y + pad, { width: cHours - 40 - L });
        doc.text(Number(l.hours).toFixed(2), cHours - 30, y + pad, { width: 60, align: 'right' });
        doc.text(`${usd(l.rateCents)}/hr`, cRate - 20, y + pad, { width: 70, align: 'right' });
        doc.text(usd(l.amountCents), cAmt - 10, y + pad, { width: 72, align: 'right' });
        y += h;
        doc.moveTo(L, y).lineTo(R, y).lineWidth(0.4).strokeColor('#E2E2E2').stroke();
      }
      y += 12;
      room(70);
      const tot = (k, v) => {
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.3).text(k, cRate - 100, y, { width: 150, align: 'right' });
        doc.fillColor(INK).text(v, cAmt - 10, y, { width: 72, align: 'right' });
        y += 16;
      };
      tot('Subtotal', usd(inv.totalCents));
      tot('Sales tax (0%)', usd(0));
      doc.moveTo(cRate - 150, y).lineTo(R, y).lineWidth(0.8).strokeColor(GOLD).stroke();
      y += 8;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('TOTAL DUE', cRate - 100, y, { width: 150, align: 'right' });
      doc.text(usd(inv.totalCents), cAmt - 20, y, { width: 82, align: 'right' });
      y += 36;

      // PAYMENT
      room(70);
      sectionHead('PAYMENT', L, W);
      y += 19;
      for (const t of [`Payable to: ${ORG.name}`, 'Terms: Due Upon Receipt', `Questions: ${ORG.email}  ·  ${ORG.phone}`]) {
        doc.fillColor(INK).font('Helvetica').fontSize(8.3).text(t, L, y);
        y = doc.y + 3;
      }

      // Footer on every page
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(pages.start + i);
        doc.page.margins.bottom = 0;   // the footer sits below the margin; without this pdfkit adds a page for it
        doc.moveTo(L, 742).lineTo(R, 742).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.fillColor(MUTED).font('Helvetica').fontSize(6.8)
          .text(`Care That Sees You. ${ORG.name}  ·  ${ORG.phone}`, L, 748, { lineBreak: false });
        if (pages.count > 1) doc.text(`Page ${i + 1} of ${pages.count}`, L, 748, { width: W, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

// ---- Pay stub (spec v1 "Pay stub contents"; owner, 2026-11-08) ---------------
// Current and year-to-date for every line. Last four of the SSN and the
// deposit account only. Drawn from the approved run's frozen numbers; nothing
// is recalculated here.
async function generatePayStubPDF({ run, worker, ytd, employerEin, ssnLast4, accountLast4, payMethod }) {
  return new Promise((resolve, reject) => {
    try {
      const ORG = consentText.ORG;
      const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const NAVY = '#033D50', GOLD = '#C9A44A', CREAM = '#FAF7F2', INK = '#1a1a1a', MUTED = '#777777';
      const L = 48, R = 564, W = R - L;
      const usd = (c) => `$${(Number(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
      const day = (ymd) => gfcTime.fmtDate(`${ymd}T12:00:00Z`);
      const p = worker.pay, y = ytd || { grossCents: 0, netCents: 0, taxes: {}, earnings: {}, reimbursementsCents: 0 };

      doc.rect(0, 0, 612, 92).fill(CREAM);
      doc.image(path.join(__dirname, 'public', 'brand', 'logo-full-color-transparent.png'), L, 18, { width: 150, height: 52 });
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text('PAY STUB', 312, 18, { width: R - 312, align: 'right' });
      let my = 44;
      for (const t of [`Pay date  ${day(run.period.payDate)}`, `Pay period  ${day(run.period.start)} to ${day(run.period.end)}`, `Stub  ${run.id.slice(0, 8).toUpperCase()}`]) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(t, 312, my, { width: R - 312, align: 'right' }); my += 11;
      }
      let y0 = 110;
      const head = (label, x, w) => { doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text(label, x, y0); doc.moveTo(x, y0 + 11).lineTo(x + w, y0 + 11).lineWidth(0.7).strokeColor('#BBBBBB').stroke(); };
      head('EMPLOYER', L, 230); head('EMPLOYEE', 312, R - 312);
      const lines = (x, arr) => { let yy = y0 + 18; arr.forEach(([t, b]) => { doc.fillColor(INK).font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(t, x, yy, { width: 240 }); yy = doc.y + 2; }); return yy; };
      const parts = String(ORG.address).split(/,\s*/);
      y0 = Math.max(
        lines(L, [[ORG.name, true], [parts.slice(0, parts.length - 2).join(', ')], [parts.slice(parts.length - 2).join(', ')], [employerEin ? `EIN ${employerEin}` : 'EIN not set']]),
        lines(312, [[worker.name, true], [ssnLast4 ? `SSN •••-••-${ssnLast4}` : 'SSN not on file'], ['Work state: Georgia']])
      ) + 14;

      const table = (title, rows, cols) => {
        doc.rect(L, y0, W, 18).fill(NAVY);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.8);
        doc.text(title, L + 8, y0 + 5.5);
        cols.forEach(([label, x, w]) => doc.text(label, x, y0 + 5.5, { width: w, align: 'right' }));
        y0 += 18;
        for (const r of rows) {
          doc.fillColor(INK).font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.3).text(r.label, L + 8, y0 + 5, { width: 250 });
          r.cells.forEach((c, i) => doc.text(c, cols[i][1], y0 + 5, { width: cols[i][2], align: 'right' }));
          y0 += 18;
          doc.moveTo(L, y0).lineTo(R, y0).lineWidth(0.4).strokeColor('#E2E2E2').stroke();
        }
        y0 += 12;
      };
      const hrs = (m) => (m ? (m / 60).toFixed(2) : '');
      table('EARNINGS', worker.earnings.map(e => ({
        label: e.label + (e.note ? ` · ${e.note}` : ''),
        cells: [e.minutes ? hrs(e.minutes) : e.count ? String(e.count) : '', usd(e.amountCents), usd((y.earnings || {})[e.code] || 0)]
      })).concat(p.reimbursementsCents ? [{ label: 'Reimbursements (not taxed)', cells: ['', usd(p.reimbursementsCents), usd(y.reimbursementsCents)] }] : []),
      [['HOURS / QTY', 330, 70], ['CURRENT', 410, 70], ['YEAR TO DATE', 486, 70]]);
      const tl = [['Federal income tax', 'federal'], ['Social Security', 'socialSecurity'], ['Medicare', 'medicare'], ['Georgia income tax', 'georgia']];
      table('TAXES WITHHELD', tl.map(([label, k]) => ({ label, cells: [usd(p.taxes[k]), usd((y.taxes || {})[k] || 0)] })), [['CURRENT', 410, 70], ['YEAR TO DATE', 486, 70]]);
      const ytdTax = Object.values(y.taxes || {}).reduce((a, v) => a + v, 0);
      table('TOTALS', [
        { label: 'Gross pay', cells: [usd(p.grossCents), usd(y.grossCents)] },
        { label: 'Taxes withheld', cells: [usd(p.taxCents), usd(ytdTax)] },
        { label: 'Deductions', cells: [usd(0), usd(0)] },
        { label: 'Net pay', bold: true, cells: [usd(p.netCents), usd(y.netCents)] }
      ], [['CURRENT', 410, 70], ['YEAR TO DATE', 486, 70]]);
      doc.moveTo(L, y0).lineTo(R, y0).lineWidth(0.8).strokeColor(GOLD).stroke();
      y0 += 10;
      const how = payMethod === 'direct_deposit' ? `Direct deposit to account ending ${accountLast4 || '----'}` : payMethod === 'check' ? 'Paper check' : payMethod === 'wise' ? 'Wise transfer' : 'Payment method not set';
      doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(`Payment: ${how}`, L, y0);
      doc.fillColor(MUTED).fontSize(7.5).text(`Questions about your pay: ${ORG.email} · ${ORG.phone}`, L, y0 + 16);
      doc.page.margins.bottom = 0;   // the footer sits below the margin
      doc.moveTo(L, 742).lineTo(R, 742).lineWidth(0.5).strokeColor('#BBBBBB').stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(6.8).text(`Care That Sees You. ${ORG.name}  ·  ${ORG.phone}`, L, 748, { lineBreak: false });
      doc.end();
    } catch (err) { reject(err); }
  });
}

// ============================================================================
// FORM W-2 (employee copies B, C, 2) and FORM 1099-NEC (Copy B, Copy 2)
// ============================================================================
// Substitute statements built to IRS Pub 1141 section 2.3 (W-2) and Pub 1179
// (1099). Black ink on white; no logo, only the employer's name (Pub 1141
// 2.01.04 allows nothing more on an employee copy). The SSN or TIN arrives
// ALREADY TRUNCATED: this function is never handed a full number.
const TAXFORM_INK = '#000000';
const taxUsd = (c) => (Number(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function taxBox(doc, x, y, w, h, label, value, { bold = false, size = 10 } = {}) {
  doc.lineWidth(bold ? 2 : 0.6).strokeColor(TAXFORM_INK).rect(x, y, w, h).stroke();
  doc.fillColor(TAXFORM_INK).font('Helvetica').fontSize(6.6).text(label, x + 3, y + 2.5, { width: w - 6, lineBreak: true, height: 16 });
  if (value !== undefined && value !== null && value !== '') {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(String(value), x + 4, y + h - size - 4, { width: w - 8, lineBreak: false });
  }
}
function taxAddrLines(a) {
  if (!a) return [];
  return [a.line1, a.line2, `${a.city || ''}, ${a.state || ''} ${a.zip || ''}${a.zip4 ? '-' + a.zip4 : ''}`].filter(s => s && String(s).trim() && String(s).trim() !== ',');
}

const W2_COPIES = Object.freeze([
  { copy: 'B', label: "Copy B, To Be Filed With Employee's FEDERAL Tax Return.", boldCore: true },
  { copy: 'C', label: "Copy C, For EMPLOYEE'S RECORDS.", note: 'This information is being furnished to the Internal Revenue Service. If you are required to file a tax return, a negligence penalty or other sanction may be imposed on you if this income is taxable and you fail to report it.' },
  { copy: '2', label: "Copy 2, To Be Filed With Employee's State, City, or Local Income Tax Return." }
]);

// Notice to Employee: the instructions on the back of the official W-2,
// trimmed to what applies to GFC's employees (Pub 1141 2.3.19), with the
// EITC notice (2.3.20).
const W2_INSTRUCTIONS = Object.freeze([
  ['Notice to Employee', ''],
  ['Do you have to file?', 'Refer to the Instructions for Forms 1040 and 1040-SR to determine if you are required to file a tax return. Even if you do not have to file a tax return, you may be eligible for a refund if box 2 shows an amount or if you are eligible for any credit.'],
  ['Earned income tax credit (EITC).', 'You may be able to take the EITC for 2026 if your adjusted gross income (AGI) is less than a certain amount. The amount of the credit is based on income and family size. Workers without children could qualify for a smaller credit. You and any qualifying children must have valid social security numbers (SSNs). You cannot take the EITC if your investment income is more than the specified amount for 2026 or if income is earned for services provided while you were an inmate at a penal institution. For 2026 income limits and more information, visit www.irs.gov/EITC. See also Pub. 596, Earned Income Credit. Any EITC that is more than your tax liability is refunded to you, but only if you file a tax return.'],
  ['Employee\'s social security number (SSN).', 'For your protection, this form may show only the last four digits of your SSN. However, your employer has reported your complete SSN to the IRS and SSA.'],
  ['Clergy and religious workers.', 'If you are not subject to social security and Medicare taxes, see Pub. 517.'],
  ['Corrections.', 'If your name, SSN, or address is incorrect, correct Copies B, C, and 2 and ask your employer to correct your employment record. Be sure to ask the employer to file Form W-2c, Corrected Wage and Tax Statement, with the Social Security Administration (SSA) to correct any name, SSN, or money amount error reported to the SSA on Form W-2. Be sure to get your copies of Form W-2c from your employer for all corrections made so you may file them with your tax return. If your name and SSN are correct but are not the same as shown on your social security card, you should ask for a new card that displays your correct name at any SSA office or by calling 800-772-1213. You may also visit the SSA website at www.SSA.gov.'],
  ['Cost of employer-sponsored health coverage (if such cost is provided by the employer).', 'The reporting in box 12, using code DD, of the cost of employer-sponsored health coverage is for your information only. The amount reported with code DD is not taxable.'],
  ['Credit for excess taxes.', 'If you had more than one employer in 2026 and more than $11,439 in social security tax was withheld, you may be able to claim a credit for the excess against your federal income tax. See the Instructions for Forms 1040 and 1040-SR.'],
  ['Box 1.', 'Enter this amount on the wages line of your tax return.'],
  ['Box 2.', 'Enter this amount on the federal income tax withheld line of your tax return.'],
  ['Box 12, code TT.', 'Total amount of qualified overtime compensation: only the premium part of overtime pay required by the Fair Labor Standards Act (the "half" of time-and-a-half). It is already included in box 1. You may be able to deduct it on your tax return. See the Instructions for Forms 1040 and 1040-SR.'],
  ['Boxes 15 to 17.', 'Georgia wages and Georgia income tax withheld. Use Copy 2 with your Georgia income tax return.'],
  ['Keep Copy C of Form W-2 for at least 3 years after the due date for filing your income tax return.', 'However, to help protect your social security benefits, keep Copy C until you begin receiving social security benefits, just in case there is a question about your work record and/or earnings in a particular year.']
]);

/**
 * employer: { name, ein, address:{line1,line2,city,state,zip,zip4}, gaWithholdingId }
 * employee: { firstName, middle, lastName, suffix, ssnTruncated, address }
 * boxes: { box1..box6, box12TT, box16, box17 }
 */
async function generateW2EmployeePDF({ year, employer, employee, boxes, corrected }) {
  if (employee && /\d{9}/.test(String(employee.ssnTruncated || '').replace(/\D/g, ''))) throw new Error('A W-2 employee copy is never given a full SSN.');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 40, info: { Title: `${year} Form W-2` } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const L = 40, R = 572, W = R - L, top = 48;
      const coreW = 128, coreH = 30, coreX = R - coreW * 2;
      const empName = [employee.firstName, employee.middle, employee.lastName, employee.suffix].filter(Boolean).join(' ');
      W2_COPIES.forEach((c, i) => {
        if (i) doc.addPage();
        doc.page.margins.bottom = 0;
        let y = top;
        // Identifying boxes on the left (never the upper right).
        taxBox(doc, L, y, coreX - L, coreH, 'a  Employee\'s social security number', employee.ssnTruncated || '');
        // Core boxes 1-6, upper right, in the official order.
        const core = [['1  Wages, tips, other compensation', boxes.box1], ['2  Federal income tax withheld', boxes.box2],
          ['3  Social security wages', boxes.box3], ['4  Social security tax withheld', boxes.box4],
          ['5  Medicare wages and tips', boxes.box5], ['6  Medicare tax withheld', boxes.box6]];
        core.forEach(([label, v], k) => {
          const cx = coreX + (k % 2) * coreW, cy = y + Math.floor(k / 2) * coreH;
          taxBox(doc, cx, cy, coreW, coreH, label, taxUsd(v), { bold: !!c.boldCore && k < 2 });
        });
        taxBox(doc, L, y + coreH, coreX - L, coreH, 'b  Employer identification number (EIN)', employer.ein || '');
        const cH = coreH * 4;
        doc.lineWidth(0.6).strokeColor(TAXFORM_INK).rect(L, y + coreH * 2, coreX - L, cH).stroke();
        doc.fillColor(TAXFORM_INK).font('Helvetica').fontSize(6.6).text('c  Employer\'s name, address, and ZIP code', L + 3, y + coreH * 2 + 2.5);
        doc.font('Helvetica').fontSize(9.5).text([employer.name, ...taxAddrLines(employer.address)].join('\n'), L + 4, y + coreH * 2 + 14, { width: coreX - L - 8 });
        // Box 12 on the right, under the core data.
        const by = y + coreH * 3;
        taxBox(doc, coreX, by, coreW * 2, coreH, '12a  See instructions for box 12', boxes.box12TT > 0 ? `TT   ${taxUsd(boxes.box12TT)}` : '');
        y += coreH * 2 + cH;
        // Employee.
        doc.lineWidth(0.6).rect(L, y, W, coreH * 3).stroke();
        doc.font('Helvetica').fontSize(6.6).text('e  Employee\'s first name and initial     Last name     Suff.', L + 3, y + 2.5);
        doc.fontSize(10).text(empName, L + 4, y + 13, { width: W - 8 });
        doc.fontSize(6.6).text('f  Employee\'s address and ZIP code', L + 3, y + 32);
        doc.fontSize(9.5).text(taxAddrLines(employee.address).join('\n'), L + 4, y + 43, { width: W - 8 });
        y += coreH * 3;
        // State boxes at the bottom.
        const sw = [70, 170, (W - 240) / 2, (W - 240) / 2];
        let sx = L;
        [['15  State', 'GA'], ['Employer\'s state ID number', employer.gaWithholdingId || ''], ['16  State wages, tips, etc.', taxUsd(boxes.box16)], ['17  State income tax', taxUsd(boxes.box17)]]
          .forEach(([label, v], k) => { taxBox(doc, sx, y, sw[k], coreH, label, v); sx += sw[k]; });
        y += coreH + 8;
        // Form number, title and year together; the copy label; the Treasury line.
        doc.font('Helvetica-Bold').fontSize(13).text(`Form W-2  Wage and Tax Statement  ${year}${corrected ? '  (CORRECTED)' : ''}`, L, y);
        doc.font('Helvetica').fontSize(8).text(`OMB No. 1545-0029`, L, y + 2, { width: W, align: 'right' });
        y += 20;
        doc.font('Helvetica-Bold').fontSize(9).text(c.label, L, y, { width: W * 0.6 });
        doc.font('Helvetica').fontSize(8).text('Department of the Treasury—Internal Revenue Service', L, y, { width: W, align: 'right' });
        y = doc.y + 8;
        if (c.note) doc.font('Helvetica').fontSize(8).text(c.note, L, y, { width: W });
        doc.font('Helvetica').fontSize(7).fillColor('#444444').text('Separate each copy along its page. Copy B goes with your federal return, Copy 2 with your Georgia return, and you keep Copy C.', L, 740, { width: W, lineBreak: false });
        doc.fillColor(TAXFORM_INK);
      });
      // Notice to Employee.
      doc.addPage();
      doc.page.margins.bottom = 40;
      doc.font('Helvetica-Bold').fontSize(13).text(`Form W-2 (${year})  Instructions for Employee`, 40, 48);
      doc.moveDown(0.6);
      for (const [h, t] of W2_INSTRUCTIONS) {
        if (!t) continue;
        doc.font('Helvetica-Bold').fontSize(8.6).text(h + ' ', { continued: true }).font('Helvetica').text(t, { width: 532 });
        doc.moveDown(0.45);
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

const NEC_INSTRUCTIONS = Object.freeze([
  ['Recipient\'s taxpayer identification number (TIN).', 'For your protection, this form may show only the last four digits of your TIN. However, the payer has reported your complete TIN to the IRS.'],
  ['Account number.', 'May show an account or other unique number the payer assigned to distinguish your account.'],
  ['Box 1a.', 'Shows nonemployee compensation. If you are in the trade or business of catching fish, box 1a may show cash you received for the sale of fish. If the amount in this box is self-employment (SE) income, report it on Schedule C or F (Form 1040) if a sole proprietor, or on Form 1065 and Schedule K-1 (Form 1065) if a partnership, and the recipient/partner completes Schedule SE (Form 1040). If you are not an employee of the payer and believe the payer should have treated you as one, see Form 8919 and Pub. 1779, Independent Contractor or Employee. If you received amounts reported in box 1a and are not engaged in a trade or business, report them as other income on Schedule 1 (Form 1040).'],
  ['Boxes 1b to 1d.', 'Show cash tips, the Treasury tipped occupation code(s) and qualified overtime compensation included in box 1a, when reported. Blank here: none were paid.'],
  ['Box 4.', 'Shows backup withholding. A payer must backup withhold on certain payments if you did not give your TIN to the payer. See Form W-9 for information on backup withholding. Include this amount on your income tax return as tax withheld.'],
  ['Boxes 5 to 7.', 'Show state income tax withheld, the state and payer\'s state number, and the state payment, when reported.'],
  ['Future developments.', 'For the latest information about developments related to Form 1099-NEC and its instructions, such as legislation enacted after they were published, go to www.irs.gov/Form1099NEC.'],
  ['Free File Program.', 'Go to www.irs.gov/FreeFile to see if you qualify for no-cost online federal tax preparation, e-filing, and direct deposit or payment options.']
]);

/**
 * payer: { name, ein, address, phone }  (payer TIN is never truncated)
 * recipient: { name, tinTruncated, address, account }
 * boxes: { box1a, box4 }
 */
async function generate1099NecPDF({ year, payer, recipient, boxes, corrected }) {
  if (recipient && /\d{9}/.test(String(recipient.tinTruncated || '').replace(/\D/g, ''))) throw new Error('A 1099 recipient copy is never given a full TIN.');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 40, info: { Title: `${year} Form 1099-NEC` } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const L = 40, R = 572, W = R - L, H = 30;
      const leftW = 300, rx = L + leftW, rw = W - leftW;
      const copies = [
        { label: 'Copy B  For Recipient', legend: 'This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.' },
        { label: "Copy 2  To be filed with recipient's state income tax return, when required." }
      ];
      copies.forEach((c, i) => {
        if (i) doc.addPage();
        doc.page.margins.bottom = 0;
        let y = 48;
        // Year, form number and name prominently together (upper right).
        doc.font('Helvetica-Bold').fontSize(14).text(`${year}  Form 1099-NEC${corrected ? '  CORRECTED' : ''}`, rx, y, { width: rw, align: 'right' });
        doc.font('Helvetica').fontSize(10).text('Nonemployee Compensation', rx, y + 18, { width: rw, align: 'right' });
        doc.fontSize(8).text('OMB No. 1545-0116', rx, y + 32, { width: rw, align: 'right' });
        doc.lineWidth(0.6).strokeColor(TAXFORM_INK).rect(L, y, leftW, H * 3).stroke();
        doc.font('Helvetica').fontSize(6.6).text('PAYER\'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.', L + 3, y + 2.5, { width: leftW - 6 });
        doc.fontSize(9.5).text([payer.name, ...taxAddrLines(payer.address), payer.phone || ''].filter(Boolean).join('\n'), L + 4, y + 20, { width: leftW - 8 });
        y += H * 3;
        taxBox(doc, L, y, leftW / 2, H, 'PAYER\'S TIN', payer.ein || '');
        taxBox(doc, L + leftW / 2, y, leftW / 2, H, 'RECIPIENT\'S TIN', recipient.tinTruncated || '');
        taxBox(doc, rx, y, rw, H, '1a  Nonemployee compensation', `$ ${taxUsd(boxes.box1a)}`, { size: 11 });
        y += H;
        // Boxes 1b to 1d are new on the 2026 form (Rev. December 2026). GFC
        // pays contractors no tips or overtime, so they stay empty.
        taxBox(doc, L, y, leftW, H, 'RECIPIENT\'S name', recipient.name || '');
        [['1b  Cash tips', ''], ['1c  Treasury tipped occupation code(s)', ''], ['1d  Overtime compensation', '']].forEach(([l, v], k) => taxBox(doc, rx + k * (rw / 3), y, rw / 3, H, l, v));
        y += H;
        doc.lineWidth(0.6).rect(L, y, leftW, H * 3).stroke();
        doc.font('Helvetica').fontSize(6.6).text('Street address (including apt. no.); City or town, state or province, country, and ZIP or foreign postal code', L + 3, y + 2.5, { width: leftW - 6 });
        doc.fontSize(9.5).text(taxAddrLines(recipient.address).join('\n'), L + 4, y + 22, { width: leftW - 8 });
        taxBox(doc, rx, y, rw, H, '2  Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', '');
        taxBox(doc, rx, y + H, rw, H, '3  Excess golden parachute payments', '');
        // "Federal income tax withheld" in bold (Pub 1179).
        doc.lineWidth(0.6).rect(rx, y + H * 2, rw, H).stroke();
        doc.font('Helvetica-Bold').fontSize(7).text('4  Federal income tax withheld', rx + 3, y + H * 2 + 2.5);
        doc.font('Helvetica').fontSize(10).text(`$ ${taxUsd(boxes.box4 || 0)}`, rx + 4, y + H * 3 - 14);
        y += H * 3;
        taxBox(doc, L, y, leftW, H, 'Account number (see instructions)', recipient.account || '');
        y += H;
        [['5  State tax withheld', ''], ['6  State/Payer\'s state no.', ''], ['7  State income', '']].forEach(([l, v], k) => taxBox(doc, L + k * (W / 3), y, W / 3, H, l, v));
        y += H + 10;
        doc.font('Helvetica-Bold').fontSize(9).text(c.label, L, y, { width: W * 0.6 });
        doc.font('Helvetica').fontSize(8).text('Department of the Treasury - Internal Revenue Service', L, y, { width: W, align: 'right' });
        y = doc.y + 6;
        if (c.legend) doc.font('Helvetica').fontSize(8).text(c.legend, L, y, { width: W });
        doc.fontSize(8).text(`Questions about this form: ${payer.phone || ''}`, L, doc.y + 6, { width: W });
      });
      doc.addPage();
      doc.page.margins.bottom = 40;
      doc.font('Helvetica-Bold').fontSize(13).text(`Form 1099-NEC (${year})  Instructions for Recipient`, 40, 48);
      doc.moveDown(0.6);
      for (const [h, t] of NEC_INSTRUCTIONS) {
        doc.font('Helvetica-Bold').fontSize(8.6).text(h + ' ', { continued: true }).font('Helvetica').text(t, { width: 532 });
        doc.moveDown(0.45);
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = {
  generatePayStubPDF,
  generateW2EmployeePDF,
  generate1099NecPDF,
  generatePhcInvoicePDF,
  generateMessageNotePDF,
  generateSignedNotePDF,
  generateAfterVisitSummaryPDF,
  generateServiceReportPDF,
  generateServiceReportWithAttachments,
  generateEnrollmentPacketPDF,
  generateConsentPDF,
  generateFaceSheetPDF,
  renderConsentBody,
  generateProviderROIPDF,
  consentProviderCopies,
  roiText,
  roiDate,
  generateVisitLogPDF,
  generateCarePlanPDF,
  generateRequisitionPDF,
  ROI_CATEGORY_LABELS
};
