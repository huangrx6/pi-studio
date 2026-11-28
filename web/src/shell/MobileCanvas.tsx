import { useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Folder, MessageCircle,
  MonitorSmartphone, ScanLine, Smartphone, MessageCirclePlus,
} from 'lucide-react';
import { BrandMark, mobileMenu, type MobileView } from './app-shell-config';
import { ShellHeader } from './ShellLayout';
import './styles/mobile-canvas.css';

function PhonePreview({ conversation }: { conversation: boolean }) {
  return <figure className="mobile-preview" role="img" aria-label={conversation ? '手机端项目对话界面预览' : '手机端工作区界面预览'}>
    <div className="mobile-screen" aria-hidden="true">
      <div className="mobile-screen-top"><BrandMark />Pi Studio<span>预览</span></div>
      {conversation ? <>
        <div className="mobile-screen-section">项目对话</div>
        <strong className="mobile-screen-title">本周工作回顾</strong>
        <div className="mobile-screen-question">帮我整理一下本周的改动。</div>
        <p className="mobile-screen-answer">可以从三个方面梳理：</p>
        <ul className="mobile-screen-points"><li>已完成的工作</li><li>需要跟进的问题</li><li>下一步安排</li></ul>
        <div className="mobile-screen-compose">输入消息…<ArrowUp /></div>
      </> : <>
        <strong className="mobile-screen-title">工作区</strong>
        <div className="mobile-screen-section">继续对话</div>
        <div className="mobile-screen-row"><MessageCircle /><div>本周工作回顾<small>项目对话示例</small></div><ChevronRight /></div>
        <div className="mobile-screen-section">桌面设备</div>
        <div className="mobile-screen-row"><MonitorSmartphone /><div>等待配对<small>配对后在这里查看设备</small></div></div>
        <div className="mobile-screen-section">项目</div>
        <div className="mobile-screen-row"><Folder /><div>项目工作区</div><ChevronRight /></div>
        <div className="mobile-screen-compose"><MessageCirclePlus />新聊天</div>
      </>}
    </div>
  </figure>;
}

function PairingGuide() {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [platform, setPlatform] = useState<'iOS' | 'Android'>('iOS');
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNextStep = useRef(false);

  function navigate(nextStep: 0 | 1 | 2) {
    focusNextStep.current = true;
    setStep(nextStep);
  }

  useLayoutEffect(() => {
    if (focusNextStep.current) {
      heading.current?.focus();
      focusNextStep.current = false;
    }
  }, [step]);

  return <div className="mobile-pairing-layout">
    {step === 0 ? <section className="mobile-intro">
      <div className="mobile-intro-brand"><BrandMark />Pi Studio 手机端</div>
      <h1 ref={heading} tabIndex={-1}>把工作区<br />装进口袋</h1>
      <p>手机端开放后，你可以在手机上查看项目对话，接着桌面上的进度聊下去。</p>
      <div className="mobile-platform-list" aria-label="手机平台"><span>iOS</span><span>Android</span></div>
      <button type="button" className="mobile-action-primary" onClick={() => navigate(1)}>开始使用<ArrowRight aria-hidden="true" /></button>
    </section> : <section className="mobile-step-card">
      <div className="mobile-step-progress" aria-hidden="true"><span /><span data-active={step === 2} /></div>
      <p className="mobile-step-number">第 {step} 步，共 2 步</p>
      <h1 ref={heading} tabIndex={-1}>{step === 1 ? '安装手机端' : '配对桌面设备'}</h1>
      {step === 1 ? <>
        <p>先在手机上安装 Pi Studio，再与这台电脑配对。</p>
        <div className="mobile-platform-switch" role="group" aria-label="选择手机平台">
          {(['iOS', 'Android'] as const).map(item =>
            <button key={item} type="button" aria-pressed={platform === item} onClick={() => setPlatform(item)}>{item}</button>
          )}
        </div>
        <div className="mobile-step-notice" role="status"><Smartphone aria-hidden="true" /><span>{platform} 版尚未开放下载。</span></div>
      </> : <>
        <p>配对功能开放后，使用手机端扫描这台电脑上的配对码，即可连接桌面工作区。</p>
        <div className="mobile-step-notice"><ScanLine aria-hidden="true" /><span>设备配对尚未开放。</span></div>
      </>}
      <div className="mobile-step-actions">
        <button type="button" className="mobile-action-back" onClick={() => navigate(step === 2 ? 1 : 0)}><ArrowLeft aria-hidden="true" />返回</button>
        {step === 1
          ? <button type="button" className="mobile-action-primary" onClick={() => navigate(2)}>继续<ArrowRight aria-hidden="true" /></button>
          : <button type="button" className="mobile-action-primary" onClick={() => navigate(0)}>返回介绍</button>}
      </div>
    </section>}
    <PhonePreview conversation={step !== 0} />
  </div>;
}

export function MobileCanvas({ view, sidebarCollapsed, onExpandSidebar }: {
  view: MobileView;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
}) {
  const title = mobileMenu.find(item => item.id === view)?.label;
  return <>
    <ShellHeader className="chat-header" onExpandSidebar={sidebarCollapsed ? onExpandSidebar : undefined}>
      <span className="main-app-title">{title}</span>
    </ShellHeader>
    <main className="main shell-canvas mobile-canvas" aria-label={title}>
      <div className="mobile-canvas-scroll">
        {view === 'pairing' ? <PairingGuide /> : <section className="mobile-devices-empty">
          <MonitorSmartphone aria-hidden="true" strokeWidth={1.5} />
          <h1>暂无已配对设备</h1>
          <p>配对功能开放后，在「手机配对」连接的设备会显示在这里。</p>
        </section>}
      </div>
    </main>
  </>;
}
