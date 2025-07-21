require("dotenv").config();
const fs = require("fs");

const baseUrl = "https://assessment.ksensetech.com/api";

const retrievePatients = async (url) => {
  console.log("Request to: ", url);

  const response = await fetch(url, {
    headers: {
      "x-api-key": process.env.HEALTH_API_KEY,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to retrieve patients. Status: ${response.status}`);
  }

  return data;
};

const wait = (delay) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(true);
    }, delay);
  });
};

const retryWrapper = async (fn, args = [], retries = 5, delay = 2000) => {
  let attempt = 0;

  while (attempt < retries) {
    try {
      const res = await fn(...args);

      if (!res.data || !Array.isArray(res.data)) {
        console.log("Invalid data: ", res);

        throw "Invalid response";
      }

      return res;
    } catch (error) {
      attempt++;
      if (attempt === retries) {
        throw error;
      }

      console.warn(`Retrying - attempt ${attempt} failed`);

      // higher backoff based on attempt number - attempt 1 will run for 1000 (default) - attempt 2 will run for 2000, etc. - full minute for more than 3 attempts in case it is 429
      attempt >= 3 ? await wait(60_000) : await wait(delay * attempt);
    }
  }
};

const evaluateBloodPressure = (value) => {
  if (!value || typeof value !== "string") return null;

  const [systolic, diastolic] = value.split("/");

  if (
    !systolic ||
    !diastolic ||
    isNaN(parseFloat(systolic)) ||
    isNaN(parseFloat(diastolic))
  )
    return null;

  const systolicNum = parseFloat(systolic);

  const diastolicNum = parseFloat(diastolic);

  if (systolicNum < 120 && diastolicNum < 80) return 0;

  if (systolicNum > 119 && systolicNum < 130 && diastolicNum < 80) return 1;

  if (
    (systolicNum > 129 && systolicNum < 140) ||
    (diastolicNum > 79 && diastolicNum < 90)
  )
    return 2;

  if (systolicNum >= 140 || diastolicNum >= 90) return 3;

  return null;
};

const evaluateTemperature = (value) => {
  if (
    !value ||
    !["string", "number"].includes(typeof value) ||
    (typeof value === "string" && isNaN(parseFloat(value)))
  )
    return null;

  if (value <= 99.5) return 0;

  if (value > 99.5 && value <= 100.9) return 1;

  if (value >= 101) return 2;

  return null;
};

const evaluateAge = (value) => {
  if (
    (!value && value !== 0) ||
    !["string", "number"].includes(typeof value) ||
    (typeof value === "string" && isNaN(parseFloat(value)))
  )
    return null;

  if (value < 40) return 0;

  if (value >= 40 && value <= 65) return 1;

  if (value > 65) return 2;

  return null;
};

const evaluateAndMapPatients = (patients) => {
  try {
    const mappedPatients = patients.map((patient) => {
      const { patient_id, name, age, blood_pressure, temperature } = patient;

      const bloodPressureScore = evaluateBloodPressure(blood_pressure);
      const temperatureScore = evaluateTemperature(temperature);
      const ageScore = evaluateAge(age);

      const totalRisk =
        (bloodPressureScore ?? 0) + (temperatureScore ?? 0) + (ageScore ?? 0);

      const riskLevel = totalRisk < 4 ? "LOW RISK" : "HIGH RISK";

      const highRisk = totalRisk >= 4;
      const fever = temperatureScore > 0;
      const dataQualityIssue =
        bloodPressureScore === null ||
        temperatureScore === null ||
        ageScore === null;

      return {
        Patient: `${patient_id} = ${name}`,
        Age: `${age} (Score: ${ageScore ?? 0})`,
        "Blood Pressure": `${blood_pressure} (Score: ${
          bloodPressureScore ?? 0
        })`,
        Temperature: `${temperature} (Score: ${temperatureScore ?? 0})`,
        "Total Risk": `${totalRisk} (${riskLevel})`,
        highRisk,
        fever,
        dataQualityIssue,
        patient_id,
      };
    });

    return mappedPatients;
  } catch (error) {
    console.error(
      "Failed to map patients - likely due to invalid data: ",
      patients
    );

    throw "Failed to map patients";
  }
};

const getAndProcessAllPatients = async (handler, page = 1, limit = 5) => {
  const response = await retryWrapper(retrievePatients, [
    `${baseUrl}/patients?page=${page}&limit=${limit}`,
  ]);

  handler(response.data);

  if (!response.pagination.hasNext) return;

  return getAndProcessAllPatients(handler, page + 1, limit);
};

const evaluate = async () => {
  try {
    const evaluatedPatients = [];

    const highRiskPatients = [];
    const feverPatients = [];
    const dataQualityIssues = [];

    const handleData = (data) => {
      const mappedData = evaluateAndMapPatients(data);

      mappedData.forEach((patientData) => {
        const {
          highRisk,
          fever,
          dataQualityIssue,
          patient_id,
          ...validEvaluatedPatient
        } = patientData;

        if (highRisk) highRiskPatients.push(patient_id);

        if (fever) feverPatients.push(patient_id);

        if (dataQualityIssue) dataQualityIssues.push(patient_id);

        evaluatedPatients.push(validEvaluatedPatient);
      });
    };

    await getAndProcessAllPatients(handleData);

    const riskSummary = {
      high_risk_patients: highRiskPatients,
      fever_patients: feverPatients,
      data_quality_issues: dataQualityIssues,
    };

    fs.writeFile(
      "./evaluatedPatients.json",
      JSON.stringify(evaluatedPatients),
      "utf-8",
      function () {
        console.log("done");
      }
    );

    const response = await fetch(`${baseUrl}/submit-assessment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.HEALTH_API_KEY,
      },
      body: JSON.stringify(riskSummary),
    });

    const assessmentResults = await response.json();

    console.log("Assessment Results: ", assessmentResults);
  } catch (error) {
    console.error("Failed to perform full health evaluations: ", error);
  }
};

evaluate();
