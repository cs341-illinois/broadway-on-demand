import React from "react";
import { Modal, Spinner } from "react-bootstrap";
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
            <Histogram data={data.binValues} xAxisTitle="Grades" yAxisTitle="# of Students" />
            <div className="d-flex flex-column">
              <p className="mb-2"><strong>Mean:</strong> {data.meanScore}</p>
              <p className="mb-2"><strong>Median:</strong> {data.medianScore}</p>
              <p className="mb-2"><strong>Standard Deviation:</strong> {data.standardDeviation}</p>
            </div>
          </>
        ) : (
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
        )}
      </Modal.Body>
    </Modal>
  );
};

export default ViewStatsModal;
