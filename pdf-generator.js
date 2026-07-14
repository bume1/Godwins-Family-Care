/**
 * PDF Generator for Service Reports and Validation Reports
 * Uses pdfkit to generate professional PDF documents
 */

const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');

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

// Human-readable consent labels for the packet.
const GFC_CONSENT_LABELS = {
  npp: 'HIPAA Notice of Privacy Practices',
  roiFamily: 'Release of Information — Family',
  roiProvider: 'Release of Information — Providers',
  roiTransfer: 'Transfer-of-Care Authorization (record release)',
  serviceAgreement: 'Service Agreement',
  billOfRights: 'Patient Bill of Rights & Self-Determination',
  emergencyFinancial: 'Emergency Treatment & Financial Responsibility',
  crisisProtocol: 'Emergency & Crisis Protocol (911/988)',
  monitoring: 'Continuous Monitoring Opt-In',
  financialAgreement: 'Financial Agreement (Private Home Care)',
  pcaScope: 'Personal Care Aide Scope Acknowledgment',
  consentToTreat: 'Consent to Medical Treatment',
  assignmentOfBenefits: 'Assignment of Benefits',
  practiceNpp: 'Medical Practice Notice of Privacy Practices'
};

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
async function generateEnrollmentPacketPDF(client) {
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
      doc.fontSize(8).fillColor(GFC_COLORS.muted)
        .text('Working draft — consent language pending counsel/licensure review. Test data until HIPAA-live.', 50, 92, { width: 380 });

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
      const signedKeys = Object.keys(consents).filter(k => consents[k] === 'signed' || consents[k] === 'na');
      if (!signedKeys.length) {
        row('—', 'No consents on file.');
      } else {
        signedKeys.forEach(k => {
          if (y > 720) { doc.addPage(); y = 50; }
          const m = meta[k] || {};
          const status = consents[k] === 'na' ? 'Declined' : 'Signed';
          doc.fontSize(10).fillColor(GFC_COLORS.navy).font('Helvetica-Bold').text(GFC_CONSENT_LABELS[k] || k, 50, y, { width: 512 });
          y += 15;
          const detail = consents[k] === 'na'
            ? 'Opt-out recorded'
            : `${status} by ${m.typedName || name}${m.signedAt ? ` on ${new Date(m.signedAt).toLocaleString('en-US')}` : ''}${m.ip ? `  ·  IP ${m.ip}` : ''}`;
          doc.fontSize(8.5).fillColor(GFC_COLORS.muted).font('Helvetica').text(detail, 50, y, { width: 512 });
          y += 20;
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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
async function generateProviderROIPDF(d) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 44, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 44;               // left margin
      const R = 612 - 44;         // right edge (LETTER width 612)
      const W = R - L;            // content width
      const cat = d.categories || {};
      const provider = d.provider || {};
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      let y = 40;

      const chk = (on) => (on ? '☑' : '☐'); // ☑ / ☐

      // Section bar: navy strip, gold numeral, white caps label.
      const section = (num, label) => {
        if (y > 700) { doc.addPage(); y = 44; }
        y += 6;
        doc.rect(L, y, W, 17).fill(ROI_COLORS.navy);
        doc.fontSize(9).fillColor(ROI_COLORS.gold).font('Helvetica-Bold').text(String(num), L + 8, y + 4.5);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
          .text(label.toUpperCase(), L + 22, y + 5, { characterSpacing: 0.6 });
        y += 24;
        doc.fillColor(ROI_COLORS.ink);
      };

      // Labeled underlined value field (one or two columns).
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

      const checkLine = (on, label, indent) => {
        if (y > 730) { doc.addPage(); y = 44; }
        const x = L + (indent || 0);
        doc.fontSize(11).fillColor(ROI_COLORS.navy).font('Helvetica').text(chk(on), x, y - 1, { continued: false });
        doc.fontSize(9.5).fillColor(ROI_COLORS.ink).font('Helvetica').text(label, x + 16, y, { width: W - 16 - (indent || 0) });
        y += Math.max(15, doc.heightOfString(label, { width: W - 16 - (indent || 0) }) + 4);
      };

      // ── Header ───────────────────────────────────────────────
      doc.fontSize(13).fillColor(ROI_COLORS.navy).font('Helvetica-Bold').text(ROI_ORG.name, L, y);
      doc.fontSize(8).fillColor(ROI_COLORS.muted).font('Helvetica')
        .text(`${ROI_ORG.address}   Tel ${ROI_ORG.tel}   Fax ${ROI_ORG.fax}`, L, y + 17, { width: W, align: 'right' });
      y += 30;
      doc.rect(L, y, W, 2).fill(ROI_COLORS.goldRule);
      y += 12;

      // ── Title ────────────────────────────────────────────────
      doc.fontSize(21).fillColor(ROI_COLORS.navy).font('Times-Bold').text('Authorization to Obtain Medical Records', L, y);
      y += 28;
      doc.fontSize(9).fillColor(ROI_COLORS.muted).font('Times-Italic')
        .text('HIPAA authorization for Godwins Family Care LLC to request and receive protected health information.', L, y, { width: W });
      y += 16;
      doc.fontSize(9.5).fillColor(ROI_COLORS.ink).font('Helvetica')
        .text('I authorize the provider or facility named below to release the medical records described to Godwins Family Care LLC, for the purpose of my treatment, care coordination, and care planning.', L, y, { width: W });
      y += doc.heightOfString('I authorize the provider or facility named below to release the medical records described to Godwins Family Care LLC, for the purpose of my treatment, care coordination, and care planning.', { width: W }) + 2;

      // ── Section 1: Patient ───────────────────────────────────
      section(1, 'Patient (whose records)');
      fieldRow([{ label: 'Patient full name', value: d.patientName }, { label: 'Date of birth', value: d.patientDOB }]);
      fieldRow([{ label: 'Address', value: d.patientAddress }, { label: 'Phone', value: d.patientPhone }]);

      // ── Section 2: Release from (this provider) ──────────────
      section(2, 'Release records from (provider or facility)');
      fieldRow([{ label: 'Provider / facility name', value: provider.name }, { label: 'Department', value: provider.dept }]);
      fieldRow([{ label: 'Address', value: provider.address }]);
      fieldRow([{ label: 'Phone', value: provider.phone }, { label: 'Fax', value: provider.fax }]);

      // ── Section 3: Release to (static) ───────────────────────
      section(3, 'Release records to');
      doc.rect(L, y, W, 34).fillAndStroke(ROI_COLORS.cream, '#cccccc');
      doc.fontSize(11).fillColor(ROI_COLORS.navy).font('Helvetica-Bold').text(ROI_ORG.name, L + 10, y + 7);
      doc.fontSize(9).fillColor(ROI_COLORS.ink).font('Helvetica')
        .text(`${ROI_ORG.address}   Tel ${ROI_ORG.tel}   Fax ${ROI_ORG.fax}`, L + 10, y + 21, { width: W - 20 });
      y += 44;

      // ── Section 4: Information authorized ────────────────────
      section(4, 'Information authorized for release');
      const catKeys = ['hp', 'lab', 'diag', 'imaging', 'meds', 'discharge', 'allergies', 'immune'];
      // Two-column checkbox grid.
      const colW2 = W / 2;
      let gridStartY = y;
      catKeys.forEach((k, i) => {
        const col = i % 2;
        const rowIdx = Math.floor(i / 2);
        const x = L + col * colW2;
        const yy = gridStartY + rowIdx * 16;
        doc.fontSize(11).fillColor(ROI_COLORS.navy).font('Helvetica').text(chk(!!cat[k]), x, yy - 1);
        doc.fontSize(9).fillColor(ROI_COLORS.ink).font('Helvetica').text(ROI_CATEGORY_LABELS[k], x + 15, yy, { width: colW2 - 20 });
      });
      y = gridStartY + Math.ceil(catKeys.length / 2) * 16 + 2;
      checkLine(!!cat.other, 'Other: ' + (cat.otherText || ''), 0);
      // Specially protected info opt-in.
      y += 2;
      doc.fontSize(8.5).fillColor(ROI_COLORS.muted).font('Helvetica-Oblique')
        .text('Specially protected information. Records of mental health, substance use treatment, HIV/AIDS, or genetic testing are released ONLY if specifically authorized here:', L, y, { width: W });
      y += doc.heightOfString('Specially protected information. Records of mental health, substance use treatment, HIV/AIDS, or genetic testing are released ONLY if specifically authorized here:', { width: W }) + 4;
      checkLine(d.includesProtected === true, 'Yes, include specially protected information listed above', 0);

      // ── Section 5: Purpose ───────────────────────────────────
      section(5, 'Purpose of disclosure');
      checkLine(d.purposeTreatment !== false, 'Treatment, care coordination, and care planning', 0);
      if (d.purposeOther) checkLine(true, 'Other: ' + (d.purposeOtherText || ''), 0);

      // ── Section 6: Expiration ────────────────────────────────
      section(6, 'Expiration');
      doc.fontSize(9.5).fillColor(ROI_COLORS.ink).font('Helvetica')
        .text('Unless revoked sooner, this authorization expires one year from the date signed, or on the earlier of:', L, y, { width: W });
      y += 16;
      fieldRow([{ label: 'Expiration date (optional)', value: d.expDate }, { label: 'Expiration event (optional)', value: d.expEvent }]);

      // ── Section 7: Rights (verbatim, required element) ───────
      section(7, 'Your rights');
      doc.fontSize(9).fillColor(ROI_COLORS.ink).font('Helvetica').text(AUTH_RIGHTS_TEXT, L, y, { width: W, align: 'left', lineGap: 1.5 });
      y += doc.heightOfString(AUTH_RIGHTS_TEXT, { width: W, lineGap: 1.5 }) + 6;

      // ── Section 8: Signature ─────────────────────────────────
      section(8, 'Signature');
      if (y > 640) { doc.addPage(); y = 44; }
      const sigBoxY = y;
      doc.fontSize(7).fillColor(ROI_COLORS.muted).font('Helvetica').text('SIGNATURE OF PATIENT OR PERSONAL REPRESENTATIVE', L, sigBoxY);
      // Embed the canvas signature image.
      const sig = d.signatureImageB64;
      if (typeof sig === 'string' && sig.startsWith('data:image')) {
        try {
          const b64 = sig.slice(sig.indexOf(',') + 1);
          const buf = Buffer.from(b64, 'base64');
          doc.image(buf, L, sigBoxY + 10, { fit: [240, 46] });
        } catch (e) { /* non-fatal: leave signature area blank */ }
      }
      doc.moveTo(L, sigBoxY + 58).lineTo(L + 300, sigBoxY + 58).strokeColor(ROI_COLORS.line).lineWidth(0.7).stroke();
      // Date to the right.
      doc.fontSize(7).fillColor(ROI_COLORS.muted).font('Helvetica').text('DATE', L + 330, sigBoxY);
      doc.fontSize(10.5).fillColor(ROI_COLORS.ink).font('Helvetica').text(d.signedDate || today, L + 330, sigBoxY + 12);
      doc.moveTo(L + 330, sigBoxY + 58).lineTo(R, sigBoxY + 58).strokeColor(ROI_COLORS.line).lineWidth(0.7).stroke();
      y = sigBoxY + 66;
      fieldRow([{ label: 'Printed name', value: d.printedName }, { label: 'If representative, relationship / authority', value: d.relationship }]);

      // ── Footer ───────────────────────────────────────────────
      doc.fontSize(7.5).fillColor(ROI_COLORS.muted).font('Helvetica-Oblique')
        .text(`${ROI_ORG.name}  ·  Authorization to Obtain Medical Records  ·  Submitted ${today}`, L, Math.min(y + 8, 760), { width: W });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateServiceReportPDF,
  generateServiceReportWithAttachments,
  generateEnrollmentPacketPDF,
  generateProviderROIPDF,
  ROI_CATEGORY_LABELS
};
