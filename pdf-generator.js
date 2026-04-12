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

        // Analyzers validated table
        if (reportData.analyzersValidated && reportData.analyzersValidated.length > 0) {
          y += 5;
          doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
          doc.text('Analyzers Validated:', 50, y);
          y += 15;
          y = drawAnalyzersTable(doc, reportData.analyzersValidated, 50, y);
        }

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
 * Draw analyzers validated table
 */
function drawAnalyzersTable(doc, analyzers, x, startY) {
  let y = startY;

  // Header
  doc.rect(x, y, 460, 18).fillColor(COLORS.headerBg).fill();
  doc.fontSize(9).fillColor(COLORS.darkGray).font('Helvetica-Bold');
  doc.text('Model', x + 5, y + 4);
  doc.text('Serial Number', x + 160, y + 4);
  doc.text('Status', x + 320, y + 4);
  y += 18;

  // Rows
  doc.font('Helvetica').fontSize(9);
  analyzers.forEach((a, i) => {
    if (i % 2 === 0) {
      doc.rect(x, y, 460, 16).fillColor(COLORS.tableBg).fill();
    }
    doc.fillColor(COLORS.black);
    doc.text(a.model || '-', x + 5, y + 3);
    doc.text(a.serialNumber || '-', x + 160, y + 3);
    doc.text(a.status || a.validationStatus || '-', x + 320, y + 3);
    y += 16;
  });

  return y + 10;
}

/**
 * Generate a Validation Report PDF (Multi-day service report)
 * @param {Object} reportData - The validation report data
 * @param {string} technicianName - Name of the technician who created the report
 * @returns {Promise<Buffer>} PDF as a Buffer
 */
async function generateValidationReportPDF(reportData, technicianName) {
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

      const startDate = new Date(reportData.startDate || reportData.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const endDate = new Date(reportData.endDate || reportData.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Header
      doc.fontSize(14).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text('THRIVE 365 LABS', 50, 30);
      doc.text('VALIDATION REPORT', 400, 30, { align: 'right' });

      doc.moveTo(50, 55).lineTo(562, 55).strokeColor(COLORS.primary).lineWidth(2).stroke();

      // Report ID
      doc.fontSize(9).fillColor(COLORS.gray).font('Helvetica');
      doc.text(`Report ID: ${reportData.id || 'N/A'}`, 50, 65);

      // VALIDATION SUMMARY Section
      let y = 95;
      doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
      doc.text('VALIDATION SUMMARY', 50, y);
      doc.moveTo(50, y + 15).lineTo(220, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
      y += 25;

      // Summary fields
      drawFieldRow(doc, 'Client/Facility', reportData.clientFacilityName || '-', 50, y);
      y += 18;
      drawFieldRow(doc, 'Start Date', startDate, 50, y, 'End Date', endDate);
      y += 18;
      drawFieldRow(doc, 'Days On-Site', String(reportData.daysOnSite || '-'), 50, y, 'Service Provider', reportData.serviceProviderName || technicianName || '-');
      y += 25;

      // ANALYZERS VALIDATED Section
      if (reportData.analyzersValidated && reportData.analyzersValidated.length > 0) {
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('ANALYZERS VALIDATED', 50, y);
        doc.moveTo(50, y + 15).lineTo(220, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 25;
        y = drawAnalyzersTable(doc, reportData.analyzersValidated, 50, y);
      }

      // TRAINING PROVIDED Section
      if (reportData.trainingProvided) {
        y += 10;
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('TRAINING PROVIDED', 50, y);
        doc.moveTo(50, y + 15).lineTo(200, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 25;
        doc.fontSize(10).fillColor(COLORS.black).font('Helvetica');
        doc.text(reportData.trainingProvided, 50, y, { width: 500 });
        y += Math.ceil(reportData.trainingProvided.length / 80) * 14 + 10;
      }

      // VALIDATION RESULTS Section
      if (reportData.validationResults) {
        y += 10;
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('VALIDATION RESULTS', 50, y);
        doc.moveTo(50, y + 15).lineTo(200, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 25;
        doc.fontSize(10).fillColor(COLORS.black).font('Helvetica');
        doc.text(reportData.validationResults, 50, y, { width: 500 });
        y += Math.ceil(reportData.validationResults.length / 80) * 14 + 10;
      }

      // OUTSTANDING ITEMS Section
      if (reportData.outstandingItems) {
        y += 10;
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('OUTSTANDING ITEMS', 50, y);
        doc.moveTo(50, y + 15).lineTo(200, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 25;
        doc.fontSize(10).fillColor(COLORS.black).font('Helvetica');
        doc.text(reportData.outstandingItems, 50, y, { width: 500 });
        y += Math.ceil(reportData.outstandingItems.length / 80) * 14 + 10;
      }

      // NEXT STEPS Section
      if (reportData.nextSteps) {
        y += 10;
        doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold');
        doc.text('NEXT STEPS', 50, y);
        doc.moveTo(50, y + 15).lineTo(150, y + 15).strokeColor(COLORS.accent).lineWidth(1).stroke();
        y += 25;
        doc.fontSize(10).fillColor(COLORS.black).font('Helvetica');
        doc.text(reportData.nextSteps, 50, y, { width: 500 });
        y += Math.ceil(reportData.nextSteps.length / 80) * 14 + 10;
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
      if (y > 580) {
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

module.exports = {
  generateServiceReportPDF,
  generateValidationReportPDF,
  generateServiceReportWithAttachments
};
