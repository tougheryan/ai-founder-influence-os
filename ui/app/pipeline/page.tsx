import { redirect } from 'next/navigation';

export default function PipelinePage() {
  redirect('/production?stage=1');
}
