import { useMemo, useState } from 'react';
import type { ArchivePreviewData } from '../types/file-preview-types';
import { Select } from './Select';
import { formatFileSize } from './filesize';

type OfficeData = Exclude<ArchivePreviewData, { format: 'zip' }>;
const elements = (parent: Document | Element, tag: string) => Array.from(parent.getElementsByTagNameNS('*', tag));
const textRuns = (parent: Element) => elements(parent, 't').map(node => node.textContent).join('');
function parseXml(xml = '') {
  if (!xml || /<!DOCTYPE/i.test(xml)) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

function documentSections(data: OfficeData) {
  const { parts, format } = data;
  if (format === 'docx') return [{ value: 'word/document.xml', label: '正文' }];
  const sheet = format === 'xlsx';
  const base = sheet ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  const index = parseXml(parts[base]);
  const rels = parseXml(parts[base.replace('/', '/_rels/') + '.rels']);
  const targets = new Map<string, string>();
  if (rels) for (const rel of elements(rels, 'Relationship')) {
    const target = rel.getAttribute('Target');
    if (!target || rel.getAttribute('TargetMode') === 'External') continue;
    const url = URL.parse(target, 'https://document.invalid/' + base);
    if (url?.origin === 'https://document.invalid') targets.set(rel.getAttribute('Id') || '', url.pathname.slice(1));
  }
  const records = index ? elements(index, sheet ? 'sheet' : 'sldId') : [];
  const label = (i: number) => sheet ? '工作表 ' + (i + 1) : '第 ' + (i + 1) + ' 页';
  const sections = records.flatMap((node, i) => {
    const ref = Array.from(node.attributes).find(attr => attr.localName === 'id' && attr.namespaceURI?.endsWith('/relationships'));
    const value = ref && targets.get(ref.value);
    return value ? [{ value, label: node.getAttribute('name') || label(i) }] : [];
  });
  if (sections.length) return sections;
  const prefix = sheet ? 'xl/worksheets/' : 'ppt/slides/';
  return Object.keys(parts).filter(key => key.startsWith(prefix)).map((value, i) => ({ value, label: label(i) }));
}

function sheetRows(document: Document, strings: string[]) {
  let clipped = false;
  const allRows = elements(document, 'row');
  const rows = allRows.slice(0, 100).map((row, index) => {
    const values: string[] = [];
    for (const cell of elements(row, 'c')) {
      const letters = /^[A-Z]+/.exec(cell.getAttribute('r') || '')?.[0];
      const column = letters ? [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1 : values.length;
      if (column >= 24) { clipped = true; continue; }
      const type = cell.getAttribute('t');
      const cached = elements(cell, 'v')[0]?.textContent;
      const formula = elements(cell, 'f')[0]?.textContent;
      let value = cached ?? (formula ? '=' + formula : '');
      if (type === 's') value = strings[Number(cached)] ?? '…';
      if (type === 'inlineStr') value = textRuns(cell);
      if (type === 'b') value = cached === '1' ? 'TRUE' : 'FALSE';
      values[column] = value;
    }
    return { number: row.getAttribute('r') || String(index + 1), values };
  });
  return { rows, cols: Math.max(0, ...rows.map(row => row.values.length)), clipped: clipped || allRows.length > rows.length };
}

function OfficeContent({ data }: { data: OfficeData }) {
  const sections = useMemo(() => documentSections(data), [data]);
  const [choice, setChoice] = useState('');
  const section = sections.find(item => item.value === choice) || sections[0];
  const doc = useMemo(() => parseXml(section && data.parts[section.value]), [data, section]);
  const strings = useMemo(() => {
    const shared = parseXml(data.parts['xl/sharedStrings.xml']);
    return shared ? elements(shared, 'si').map(textRuns) : [];
  }, [data]);
  const sheet = useMemo(() => doc && data.format === 'xlsx' ? sheetRows(doc, strings) : null, [doc, strings, data.format]);
  const paragraphs = useMemo(() => doc && !sheet ? elements(doc, 'p').map(textRuns).filter(Boolean) : [], [doc, sheet]);
  return <div className="file-preview-office">
    {sections.length > 1 && <Select label={data.format === 'xlsx' ? '选择工作表' : '选择幻灯片'} value={section.value} options={sections} onChange={setChoice} />}
    {sheet && sheet.cols > 0 ? <div className="file-preview-table-wrap"><table><thead><tr><th scope="col">行</th>
      {Array.from({length: sheet.cols}, (_, i) => <th key={i} scope="col">{String.fromCharCode(65 + i)}</th>)}</tr></thead>
      <tbody>{sheet.rows.map((row, i) => <tr key={i}><th scope="row">{row.number}</th>
        {Array.from({length: sheet.cols}, (_, col) => <td key={col}>{row.values[col]}</td>)}</tr>)}</tbody></table></div>
      : paragraphs.length ? paragraphs.slice(0, 500).map((value, i) => <p key={i}>{value}</p>)
      : <p className="file-preview-inline-note">{doc ? '此页没有可预览的文字或单元格。' : '此页内容无法读取。'}</p>}
    {(data.clipped || sheet?.clipped || paragraphs.length > 500) && <p className="file-preview-inline-note">内容较多，仅展示部分预览。</p>}
  </div>;
}

export function ArchivePreview({ data }: { data: ArchivePreviewData }) {
  if (data.format !== 'zip') return <OfficeContent data={data} />;
  return <section className="file-preview-archive">
    <h4>压缩包内容 <small>{data.count} 个文件</small></h4>
    <ul>{data.entries.map(entry => <li key={entry.name}><span>{entry.name}</span><small>{formatFileSize(entry.size)}</small></li>)}</ul>
    {data.count > data.entries.length && <p>已显示前 {data.entries.length} 个文件。</p>}
  </section>;
}
