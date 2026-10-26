import { DayView } from './day-view';

export const metadata = { title: 'Day' };

export default async function DayPage({ params }: { params: Promise<{ date: string }> }) {
  return <DayView date={(await params).date} />;
}
