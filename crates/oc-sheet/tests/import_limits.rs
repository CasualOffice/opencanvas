// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! What an uploaded workbook may make the server allocate (SEC-V4, `POST /v1/import?format=xlsx`).

use std::io::Write as _;

use oc_sheet::block::{FileFormat, from_file};
use zip::write::SimpleFileOptions;

/// A minimal `.xlsx` whose one sheet is `sheet_data` (the `<sheetData>` children), plus an
/// optional stored (uncompressed) part.
fn xlsx(sheet_data: &str, filler: &[u8], extra: Option<&[u8]>) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let deflate = SimpleFileOptions::default();
    let parts: [(&str, String); 5] = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.into(),
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.into(),
        ),
        (
            "xl/workbook.xml",
            r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="One" sheetId="1" r:id="rId1"/></sheets></workbook>"#.into(),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.into(),
        ),
        (
            "xl/worksheets/sheet1.xml",
            format!(
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_data}</sheetData></worksheet>"#
            ),
        ),
    ];
    for (name, body) in parts {
        z.start_file(name, deflate).unwrap();
        z.write_all(body.as_bytes()).unwrap();
        if name.ends_with("sheet1.xml") {
            z.write_all(filler).unwrap();
        }
    }
    if let Some(extra) = extra {
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        z.start_file("xl/media/extra.bin", stored).unwrap();
        z.write_all(extra).unwrap();
    }
    z.finish().unwrap().into_inner()
}

#[test]
fn a_small_workbook_imports() {
    let b = from_file(
        &xlsx(
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>hi</t></is></c></row>"#,
            b"",
            None,
        ),
        FileFormat::Xlsx,
    )
    .unwrap();
    assert_eq!(b["sheets"]["s0"]["cells"]["s0r0:s0c0"]["in"], "hi");
}

/// One value in the last cell of the grid made a block of 1,048,576 row ids and 16,384 column
/// ids from a file of a few hundred bytes.
#[test]
fn a_cell_far_out_does_not_build_a_huge_grid() {
    let bytes = xlsx(
        r#"<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>"#,
        b"",
        None,
    );
    assert!(bytes.len() < 2_000);
    match from_file(&bytes, FileFormat::Xlsx) {
        Err(e) => assert!(e.0.contains("rows") || e.0.contains("columns"), "{}", e.0),
        Ok(b) => panic!(
            "imported with {} rows and {} columns",
            b["sheets"]["s0"]["rows"].as_array().unwrap().len(),
            b["sheets"]["s0"]["cols"].as_array().unwrap().len()
        ),
    }
}

/// A part that inflates to 80 MB is refused, while the archive's overall ratio stays under the
/// reader's 1000:1 bomb check (an incompressible part pads the compressed size).
#[test]
fn a_part_that_inflates_past_the_import_budget_is_refused() {
    let filler = vec![b' '; 80 * 1024 * 1024];
    let mut noise = vec![0u8; 256 * 1024];
    let mut x: u32 = 0x9e37_79b9;
    for b in noise.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    let bytes = xlsx(
        r#"<row r="1"><c r="A1"><v>1</v></c></row>"#,
        &filler,
        Some(&noise),
    );
    assert!(bytes.len() < 5 * 1024 * 1024, "{}", bytes.len());
    let err = from_file(&bytes, FileFormat::Xlsx).expect_err("an 80 MB part was inflated");
    assert!(err.0.contains("not a readable workbook"), "{}", err.0);
}
