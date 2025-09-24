import { useEffect, useRef } from 'react';

export interface HistogramProps {
    data: number[];
}

export function Histogram({ 
    data,
}: HistogramProps) {
    const plotRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const loadPlotly = () => {
            if ((window as any).Plotly) {
                createPlot();
            } else {
                const script = document.createElement('script');
                script.src = 'https://cdn.plot.ly/plotly-2.3.0.min.js';
                script.onload = () => createPlot();
                document.head.appendChild(script);
            }
        };

        const createPlot = () => {
            const Plotly = (window as any).Plotly;
            
            if (plotRef.current && Plotly && data.length > 0) {
                const plotData = [{
                    x: data,
                    type: 'histogram',
                    xbins: {
                        start: 0,
                        end: 101,
                        size: 10
                    },
                    marker: {
                        color: '#13294b'
                    },
                }];

                const layout = {
                    xaxis: {
                        title: {
                            text: 'Grade',
                            font: {
                                family: 'Source Sans, sans-serif',
                                size: 14,
                                color: '#252525'
                            }
                        },
                        range: [0, 100.1],
                        dtick: 10,
                        tickfont: {
                            family: 'Source Sans, sans-serif',
                            size: 12,
                            color: '#4a4c4b'
                        },
                        gridcolor: '#c6c7c7'
                    },
                    yaxis: {
                        title: {
                            text: '# of Students',
                            font: {
                                family: 'Source Sans, sans-serif',
                                size: 14,
                                color: '#252525'
                            }
                        },
                        tickfont: {
                            family: 'Source Sans, sans-serif',
                            size: 12,
                        },
                        dtick: 1,
                    },
                    plot_bgcolor: 'white',
                    paper_bgcolor: 'white',
                    margin: {
                        l: 60,
                        r: 30,
                        t: 50,
                        b: 60
                    }
                };

                const config = {
                    displayModeBar: false,
                    staticPlot: true
                };

                Plotly.newPlot(plotRef.current, plotData, layout, config);
            }
        };

        loadPlotly();

        return () => {
            const Plotly = (window as any).Plotly;
            if (plotRef.current && Plotly) {
                Plotly.purge(plotRef.current);
            }
        };
    }, [data]);

    return (
        <>
            <div 
                ref={plotRef} 
            />
        </>
    );
}