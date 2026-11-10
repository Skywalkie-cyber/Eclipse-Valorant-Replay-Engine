import { render } from 'solid-js/web';
import { ClipOverlayNotification } from './components/ClipOverlayNotification';
import './index.css';

const root = document.getElementById('root');
if (root) {
  render(() => (
    <div
      className="w-full h-full bg-transparent overflow-hidden p-2 select-none pointer-events-none"
      style={{ background: 'transparent', 'background-color': 'transparent' }}
    >
      <ClipOverlayNotification isStandaloneWindow={true} />
    </div>
  ), root);
}

