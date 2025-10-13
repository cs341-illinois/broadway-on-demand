import { useEffect, useRef } from 'react';
import { HISTOGRAM_BIN_WIDTH, HISTOGRAM_COL_MARKER_HEIGHT } from '../../constants';

export interface HistogramProps {
  xAxisTitle: string;
  yAxisTitle: string
  data: number[];
}

export function Histogram({ data, xAxisTitle, yAxisTitle }: HistogramProps) {
  const plotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data || data.length === 0) return;

    const loadPlotly = () => {
      if ((window as any).Plotly) {
        createPlot();
      } else {
        const script = document.createElement('script');
        script.src = 'https://cdn.plot.ly/plotly-2.3.0.min.js';
        script.onload = createPlot;
        document.head.appendChild(script);
      }
    };

    const createPlot = () => {
      const Plotly = (window as any).Plotly;
      if (!Plotly || !plotRef.current) return;

      const numBins = data.length;
      const binSize = HISTOGRAM_BIN_WIDTH;

      const fontFamily = getComputedStyle(document.documentElement)
        .getPropertyValue('--il-font-sans')
        .trim() || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

      const xBarPositions = Array.from({ length: numBins }, (_, i) => i * binSize + binSize / 2);
      const tickPositions = Array.from({ length: numBins + 1 }, (_, i) => i * binSize);

      const plotData = [
        {
          x: xBarPositions,
          y: data,
          type: 'bar',
          width: binSize,
          marker: { color: '#13294b' },
        },
      ];

      const layout = {
        font: {
          family: fontFamily,
        },
        xaxis: {
          title: {
            text: xAxisTitle,
            font: { size: 14, color: '#252525', family: fontFamily }
          },
          tickvals: tickPositions,
          ticktext: tickPositions.map((v) => v.toString()),
          tickfont: { size: 12, color: '#4a4c4b', family: fontFamily },
          gridcolor: '#c6c7c7',
        },
        yaxis: {
          title: {
            text: yAxisTitle,
            font: { size: 14, color: '#252525', family: fontFamily }
          },
          tick0: 0,
          dtick: HISTOGRAM_COL_MARKER_HEIGHT,
          tickfont: { size: 12, family: fontFamily },
        },
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        margin: { l: 60, r: 30, t: 50, b: 60 },
      };

      const config = { displayModeBar: false, staticPlot: true };
      Plotly.newPlot(plotRef.current, plotData, layout, config);
    };

    loadPlotly();

    return () => {
      const Plotly = (window as any).Plotly;
      if (plotRef.current && Plotly) Plotly.purge(plotRef.current);
    };
  }, [data]);

  return <div ref={plotRef} />;
}
