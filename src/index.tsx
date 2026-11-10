/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App';
import { ClipOverlayNotification } from './components/ClipOverlayNotification';
import './index.css';

const root = document.getElementById('root');
if (root) {
  const isOverlay = window.location.search.includes('overlay=1');
  if (isOverlay) {
    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');
    document.body.style.backgroundColor = 'transparent';
    render(() => <ClipOverlayNotification isStandaloneWindow={true} />, root);
  } else {
    render(() => <App />, root);
  }
}

