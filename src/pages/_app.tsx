import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { lightTheme } from '@storyblok/mui';
import { CssBaseline, ThemeProvider } from '@mui/material';

export default function App({ Component, pageProps }: AppProps) {
	return (
		<ThemeProvider theme={lightTheme}>
			<CssBaseline />
			<Component {...pageProps} />
		</ThemeProvider>
	);
}
