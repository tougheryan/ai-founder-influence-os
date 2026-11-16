import { redirect } from 'next/navigation';

export default function DeliveryPage() {
  redirect('/production?stage=4');
}
