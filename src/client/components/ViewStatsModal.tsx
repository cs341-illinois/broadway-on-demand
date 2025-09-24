import React from "react";
import { Modal } from "react-bootstrap";
import { Histogram } from "./Histogram";

interface ViewStatsModalProps {
  show: boolean;
  onCancel: () => void;
  data: number[];
}

const calculateMean = (arr: any[]) => {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((acc: any, curr: any) => acc + curr, 0);
  return sum / arr.length;
};
const calculateMedian = (arr: string | any[]) => {
  if (arr.length === 0) return 0;
  const sortedArr = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sortedArr.length / 2);

  if (sortedArr.length % 2 === 0) {
    return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  } else {
    return sortedArr[mid];
  }
};
const calculateStdDev = (arr: any[]) => {
  if (arr.length === 0) return 0;
  const mean = calculateMean(arr);
  const squaredDifferences = arr.map((num: number) => Math.pow(num - mean, 2));
  const sumOfSquaredDifferences = squaredDifferences.reduce((acc: any, curr: any) => acc + curr, 0);
  const variance = sumOfSquaredDifferences / arr.length;
  return Math.sqrt(variance);
};

const ViewStatsModal: React.FC<ViewStatsModalProps> = ({
  show,
  onCancel,
  data,
}) => {
  return (
    <Modal show={show} onHide={onCancel} centered>
      <Modal.Header closeButton>
        <Modal.Title>Assignment Statistics</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Histogram data={data}/>
        <div className="d-flex flex-column">
          <p className="mb-2">Mean: {calculateMean(data)}</p>
          <p className="mb-2">Median: {calculateMedian(data)}</p>
          <p className="mb-2">Standard Deviation: {calculateStdDev(data)}</p>
        </div>
      </Modal.Body>
    </Modal>
  );
};

export default ViewStatsModal;
