"""
backend/services/pdf_builder.py
Builds the TEMP patient-intake PDF in memory (ReportLab).

This is the rough/temp PDF. App Service uploads it to temp-intake; the
Function App later runs it through Document Intelligence to produce the
polished final PDF in the 'pdfs' container.

Keep this simple and machine-readable — a clean labelled table is easier for
Document Intelligence to parse than heavy styling.
"""

import logging
from io import BytesIO
from datetime import datetime

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles    import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units     import inch
from reportlab.lib           import colors
from reportlab.platypus      import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

log = logging.getLogger(__name__)

LANGUAGE_NAMES = {
    'en-CA': 'English',  'en-US': 'English',
    'fr-FR': 'French',   'es-ES': 'Spanish',
    'zh-CN': 'Mandarin', 'ar-SA': 'Arabic',
    'pa-IN': 'Punjabi',  'fil-PH': 'Tagalog',
    'pt-BR': 'Portuguese', 'hi-IN': 'Hindi', 'vi-VN': 'Vietnamese',
}


def build_temp_pdf(submission_id, language_code, submitted_at, answers, field_order):
    """
    Build the temp intake PDF.

    Args:
        submission_id: UUID string
        language_code: BCP-47 code
        submitted_at:  ISO-8601 string
        answers:       dict label -> English answer text
        field_order:   list of labels in display order

    Returns:
        PDF file bytes
    """
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=LETTER,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
        topMargin=0.75 * inch,  bottomMargin=0.75 * inch,
        title='Patient Intake Form',
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('t', parent=styles['Heading1'], fontSize=18,
                                 textColor=colors.HexColor('#0F766E'), spaceAfter=4)
    sub_style   = ParagraphStyle('s', parent=styles['BodyText'], fontSize=10,
                                 textColor=colors.HexColor('#6B7280'), spaceAfter=12)
    cell_label  = ParagraphStyle('cl', parent=styles['BodyText'], fontSize=10,
                                 fontName='Helvetica-Bold',
                                 textColor=colors.HexColor('#374151'))
    cell_value  = ParagraphStyle('cv', parent=styles['BodyText'], fontSize=10,
                                 textColor=colors.HexColor('#111827'))
    note_style  = ParagraphStyle('n', parent=styles['BodyText'], fontSize=8,
                                 textColor=colors.HexColor('#9CA3AF'), spaceBefore=18)

    story = []
    story.append(Paragraph('Patient Intake Form', title_style))

    language_label = LANGUAGE_NAMES.get(language_code, language_code)
    submitted_disp = _fmt_ts(submitted_at)
    story.append(Paragraph(
        f'Submitted {submitted_disp} &nbsp;|&nbsp; Spoken language: {language_label} '
        f'&nbsp;|&nbsp; ID: {submission_id}',
        sub_style,
    ))
    story.append(Spacer(1, 6))

    # One row per field: label | English answer
    rows = []
    for label in field_order:
        value = answers.get(label, '') or '—'
        rows.append([Paragraph(label, cell_label), Paragraph(_esc(value), cell_value)])

    table = Table(rows, colWidths=[2.2 * inch, 4.3 * inch])
    table.setStyle(TableStyle([
        ('BACKGROUND',   (0, 0), (0, -1), colors.HexColor('#F3F4F6')),
        ('VALIGN',       (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING',  (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING',   (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 7),
        ('BOX',          (0, 0), (-1, -1), 0.5, colors.HexColor('#E5E7EB')),
        ('INNERGRID',    (0, 0), (-1, -1), 0.5, colors.HexColor('#E5E7EB')),
    ]))
    story.append(table)

    story.append(Paragraph(
        'Temporary intake document generated from voice recordings. '
        'Pending final processing.',
        note_style,
    ))

    doc.build(story)
    pdf = buffer.getvalue()
    buffer.close()
    log.info(f'[pdf] temp PDF built for {submission_id} ({len(pdf)} bytes)')
    return pdf


def _esc(text: str) -> str:
    if not text:
        return '—'
    return (text.replace('&', '&amp;').replace('<', '&lt;')
                .replace('>', '&gt;').replace('\n', '<br/>'))


def _fmt_ts(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%Y-%m-%d %H:%M UTC')
    except Exception:
        return iso or '—'
