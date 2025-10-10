import React from "react";
import { Modal } from "react-bootstrap";
import { Histogram } from "./Histogram";
import { StatsResponse } from "../../types/stats";

interface ViewStatsModalProps {
  show: boolean;
  onCancel: () => void;
  data: StatsResponse;
}

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
        {data ? (
          <>
            <Histogram data={data.binValues}/>
            <div className="d-flex flex-column">
              <p className="mb-2">Mean: {data.meanScore}</p>
              <p className="mb-2">Median: {data.medianScore}</p>
              <p className="mb-2">Standard Deviation: {data.standardDeviation}</p>
            </div>
          </>
        ) : (
          <p>Loading...</p>
        )}
      </Modal.Body>
    </Modal>
  );
};

export default ViewStatsModal;
