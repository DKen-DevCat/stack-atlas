import { renderPlaceholder } from './placeholder';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) renderPlaceholder(app);
