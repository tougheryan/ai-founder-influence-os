import type { Metadata } from 'next';
import { ContentRadarWorkbench } from '@/components/content-radar/ContentRadarWorkbench';

export const metadata: Metadata = {
  title: 'Echo Founder · 内容创作工作台',
  description: '管理素材、研究选题、生成内容并记录发布结果。',
};

export default function ContentRadarPage() {
  return <ContentRadarWorkbench />;
}
