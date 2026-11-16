import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Archive,
  ArrowUpRight,
  Eye,
  GitBranch,
  LibraryBig,
  Repeat2,
  type LucideIcon,
} from 'lucide-react';
import { EchoFounderMark } from '@/components/brand/EchoFounderMark';
import './home-welcome.css';

export const metadata: Metadata = {
  title: 'Echo Founder',
  description: '把个性化做成资产，把可信做成系统能力。',
};

type Capability = {
  title: string;
  body: string;
  icon: LucideIcon;
};

const capabilities: Capability[] = [
  {
    title: '可沉淀',
    body: '个人背景、表达风格、素材、案例和历史内容都进入长期知识库。',
    icon: Archive,
  },
  {
    title: '可复用',
    body: '同一段素材可为各平台独立生成原生内容，也可在未来课程、演讲和文章中再次调用。',
    icon: Repeat2,
  },
  {
    title: '可解释',
    body: '系统展示内容来源、生成逻辑、平台建议和修改依据。',
    icon: Eye,
  },
  {
    title: '可追溯',
    body: '每条内容保留原始素材、审核记录、发布版本和数据反馈。',
    icon: GitBranch,
  },
  {
    title: '越用越懂',
    body: '持续输入带来更优数据，系统迭代后生成内容越来越贴合本人。',
    icon: LibraryBig,
  },
];

function CapabilityCard({ capability }: { capability: Capability }) {
  const Icon = capability.icon;

  return (
    <article className="welcome-card">
      <div className="welcome-card__head">
        <span className="welcome-card__icon" aria-hidden="true">
          <Icon />
        </span>
        <h2>{capability.title}</h2>
      </div>
      <p>{capability.body}</p>
    </article>
  );
}

export default function HomePage() {
  // Duplicating the sequence lets the track loop without a visible reset.
  const marqueeCards = [...capabilities, ...capabilities];

  return (
    <div className="welcome-page">
      <main className="welcome-stage">
        <div className="welcome-stage__glow" aria-hidden="true" />
        <div className="welcome-stage__signals" aria-hidden="true" />

        <header className="welcome-nav">
          <Link href="/" className="welcome-brand" aria-label="Echo Founder 首页">
            <span className="welcome-brand__mark" aria-hidden="true"><EchoFounderMark size={40} /></span>
            <span>Echo Founder</span>
          </Link>
        </header>

        <section className="welcome-hero" aria-labelledby="welcome-title">
          <p className="welcome-eyebrow">TRUSTABLE ASSET SYSTEM</p>
          <h1 id="welcome-title">
            让创始人的一个观点，
            <span>生长为全球影响力。</span>
          </h1>
          <p className="welcome-hero__description">
            <span>从一段访谈、一篇文章或一条语音开始，沉淀你的知识库，</span>
            <span>并生成公众号、视频号、小红书等多平台原生内容。</span>
          </p>
          <Link className="welcome-workbench" href="/production?stage=1">
            进入工作台 <ArrowUpRight aria-hidden="true" size={18} />
          </Link>
        </section>

        <section className="welcome-capabilities" aria-label="系统能力">
          <div className="welcome-capabilities__track">
            {marqueeCards.map((capability, index) => (
              <CapabilityCard capability={capability} key={`${capability.title}-${index}`} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
