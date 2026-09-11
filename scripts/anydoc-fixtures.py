#!/usr/bin/env python3
"""Generate small real office/PDF documents for the container smoke test (stdlib only)."""
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
marker = 'NanoClaw document fixture'
ns = 'http://schemas.openxmlformats.org/'

def office(name, content_type, main, files):
    types = f'<Types xmlns="{ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/{main}" ContentType="{content_type}"/></Types>'
    rels = f'<Relationships xmlns="{ns}package/2006/relationships"><Relationship Id="rId1" Type="{ns}officeDocument/2006/relationships/officeDocument" Target="{main}"/></Relationships>'
    with zipfile.ZipFile(root / name, 'w', zipfile.ZIP_DEFLATED) as archive:
        for key, value in {'[Content_Types].xml': types, '_rels/.rels': rels, **files}.items():
            archive.writestr(key, value)

office('sample.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'word/document.xml', {
    'word/document.xml': f'<w:document xmlns:w="{ns}wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{marker}</w:t></w:r></w:p></w:body></w:document>'
})
office('sample.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'xl/workbook.xml', {
    'xl/workbook.xml': f'<workbook xmlns="{ns}spreadsheetml/2006/main" xmlns:r="{ns}officeDocument/2006/relationships"><sheets><sheet name="Sample" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{ns}package/2006/relationships"><Relationship Id="rId1" Type="{ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{marker}</t></is></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>'
})
office('sample.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', 'ppt/presentation.xml', {
    'ppt/presentation.xml': f'<p:presentation xmlns:p="{ns}presentationml/2006/main" xmlns:r="{ns}officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{ns}package/2006/relationships"><Relationship Id="rId1" Type="{ns}officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': f'<p:sld xmlns:p="{ns}presentationml/2006/main" xmlns:a="{ns}drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{marker}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
})

def pdf(name, text):
    stream = f'BT /F1 14 Tf 72 720 Td ({text}) Tj ET'.encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
    data = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for offset in offsets[1:]:
        data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    (root / name).write_bytes(data)

pdf('sample.pdf', marker)
pdf('empty.pdf', '')
(root / 'corrupt.docx').write_text('not a ZIP archive')
(root / 'sample.csv').write_text(f'name,value\n{marker},42\n')
(root / "sample $(touch SHOULD_NOT_EXIST) 'quoted'.txt").write_text(marker)
