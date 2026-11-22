import { notFound } from 'next/navigation';
import { Gallery } from './Gallery';

export const metadata = { title: 'UI primitives (dev)', robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Gallery />;
}
