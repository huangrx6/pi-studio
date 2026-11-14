import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Select } from '../../../web/src/shared/Select';
import { DatePicker } from '../../../web/src/shared/DatePicker';
import { ActionMenu } from '../../../web/src/shared/ActionMenu';
import { SettingsDialog } from '../../../web/src/shared/SettingsDialog';
import { WorkspacePicker } from '../../../web/src/shell/WorkspacePicker';
import { useActionConfirmation, ToolConfirmDialog } from '../../../web/src/shared/ConfirmDialog';
import '../../../web/src/styles/tokens.css';
import '../../../web/src/styles/palette.css';
import '../../../web/src/app.css';

function Fixture() {
  const confirmation = useActionConfirmation();
  const [toolConfirm, setToolConfirm] = useState(false);
  const [outer, setOuter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState('disabled');
  const [date, setDate] = useState('2026-11-06');
  const [result, setResult] = useState('');
  return <div style={{ padding: 32 }}>
    <button onClick={() => setOuter(true)}>打开表单</button>
    <button onClick={() => { void confirmation.confirm({ title: '丢弃修改？', confirmLabel: '丢弃' }).then(ok => setResult(String(ok))); }}>打开确认</button>
    <button onClick={() => setMenu(true)}>打开操作</button>
    <button id="destination">下一控件</button>
    <output>{result}</output>
    <span className="spin" aria-label="测试减动效">◌</span>
    <button onClick={() => setTick(tick + 1)}>刷新父组件</button>
    {menu && <ActionMenu x={120} y={90} onClose={() => setMenu(false)} items={[
      { label: '第一项', run: () => setResult('first') },
      { label: '禁用项', disabled: true, run() {} },
      { label: '最后一项', run: () => document.getElementById('destination')?.focus() },
    ]} />}
    {outer && <SettingsDialog title="测试表单" action="保存" busy={false} loading={false} error={null} onClose={() => setOuter(false)} onSubmit={() => setResult('saved')}>
      <input aria-label="编辑名称" defaultValue="中文" />
      <Select label="测试选择" value={selected} onChange={setSelected} options={[{ value: 'disabled', label: '已停用', disabled: true }, { value: 'a', label: '选项 A' }, { value: 'b', label: '选项 B' }, { value: 'c', label: '选项 C' }]} />
      <button onClick={() => void confirmation.confirm({ title: '嵌套确认', confirmLabel: '继续' })} type="button">打开嵌套确认</button>
      <DatePicker label="测试日期" value={date} onChange={setDate} />
      <details><summary>展开高级选项</summary><button type="button">折叠内操作</button></details>
      <button type="button">表单末字段</button>
    </SettingsDialog>}
    <button onClick={() => setToolConfirm(true)}>工具确认</button>
    {toolConfirm && <ToolConfirmDialog request={{ id: 'qa', title: '工具权限确认', tool: 'read', message: '读取测试文件', rememberScopes: ['session', 'workspace'] }} onRespond={() => setToolConfirm(false)} />}
    {confirmation.dialog}
    <main className="main" style={{ height: 'calc(100vh - 150px)', justifyContent: 'center' }}>
      <WorkspacePicker value="" workspaces={Array.from({ length: 8 }, (_, index) => ({
        name: `项目 ${index}`, cwd: `/workspace/projects/long-directory-name-for-wrapping/team-documents/project-${index}`,
      }))} onChange={setResult} onBrowse={() => setResult('browse')} />
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
