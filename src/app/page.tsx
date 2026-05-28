import { redirect } from 'next/navigation';

export default function Home() {
  // The root is the staff entry point. Send visitors to the dashboard; the
  // middleware bounces unauthenticated requests on to /login.
  redirect('/dashboard');
}
